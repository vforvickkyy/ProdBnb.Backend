import { randomUUID } from "crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// R2 mocked wholesale. `objects` lets a test decide what HeadObject "finds" after an upload.
const r2 = vi.hoisted(() => ({
  objects: new Map<string, { contentType: string; contentLength: number }>(),
  deleted: new Set<string>(),
}));
vi.mock("../src/lib/r2", () => ({
  objectKeyFor: (locationId: string, mediaId: string) => `locations/${locationId}/${mediaId}/original`,
  publicUrlFor: (key: string) => `https://mock-cdn.example.com/${key}`,
  presignUpload: async () => ({ url: "https://mock-r2.example.com/upload", expiresAt: new Date(Date.now() + 900_000) }),
  headObject: async (key: string) => r2.objects.get(key) ?? null,
  deleteObject: async (key: string) => {
    r2.deleted.add(key);
  },
  checkBucketAccess: async () => undefined,
}));

import { createApp } from "../src/app";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

const app = createApp();
const CITY = `Console2 City ${randomUUID().slice(0, 8)}`;

function auth(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${user.accessToken}` };
}

async function makeAdmin(user: TestUser, teamRole: "super_admin" | "moderator" | "support" | "finance"): Promise<void> {
  const { error } = await adminClient.from("user_roles").insert({ user_id: user.id, role: "admin" });
  if (error) throw error;
  if (teamRole !== "super_admin") {
    const { error: roleError } = await adminClient.from("admin_team_members").update({ team_role: teamRole }).eq("user_id", user.id);
    if (roleError) throw roleError;
  }
}

async function grantHost(user: TestUser): Promise<void> {
  await request(app).post("/v1/me/roles").set(auth(user)).send({ role: "host" }).expect(201);
}

async function audit(action: string, targetId: string) {
  const { data, error } = await adminClient
    .from("admin_audit_log")
    .select("*")
    .eq("action", action)
    .eq("target_id", targetId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

describe("Admin Console 2: listings created for a host, catalog covers + listings, collections", () => {
  let superAdmin: TestUser;
  let moderator: TestUser;
  let finance: TestUser;
  let host: TestUser;
  let booker: TestUser;
  const collectionIds: string[] = [];
  const categoryIds: string[] = [];

  beforeAll(async () => {
    [superAdmin, moderator, finance, host, booker] = await Promise.all([
      createTestUser(),
      createTestUser(),
      createTestUser(),
      createTestUser(),
      createTestUser(),
    ]);
    await makeAdmin(superAdmin, "super_admin");
    await makeAdmin(moderator, "moderator");
    await makeAdmin(finance, "finance");
    await grantHost(host);
  });

  afterAll(async () => {
    if (collectionIds.length > 0) {
      await adminClient.from("collections").delete().in("id", collectionIds);
    }
    if (categoryIds.length > 0) {
      await adminClient.from("categories").delete().in("id", categoryIds);
    }
    for (const user of [superAdmin, moderator, finance, host, booker]) {
      await deleteTestUser(user.id);
    }
  });

  async function createForHost(body: Record<string, unknown>, as: TestUser = moderator) {
    return request(app)
      .post("/v1/admin/locations")
      .set(auth(as))
      .send({ title: "Admin-made Studio", city: CITY, country: "India", ...body });
  }

  // -- Listings for a host ----------------------------------------------------------------------

  it("creates a draft listing owned by the host, audited, visible in the host's own list", async () => {
    const res = await createForHost({ host_id: host.id, description: "Made by the team" });
    expect(res.status).toBe(201);
    expect(res.body.data.host_id).toBe(host.id);
    expect(res.body.data.status).toBe("draft");

    const [entry] = await audit("ADMIN_CREATED_LOCATION", res.body.data.id);
    expect(entry.admin_id).toBe(moderator.id);
    expect(entry.metadata).toMatchObject({ host_id: host.id, status: "draft", granted_host_role: false });

    const mine = await request(app).get("/v1/me/locations").set(auth(host)).expect(200);
    expect(mine.body.data.map((l: { id: string }) => l.id)).toContain(res.body.data.id);
  });

  it("refuses a non-host unless grant_host_role is set, then grants it in the same step", async () => {
    const refused = await createForHost({ host_id: booker.id });
    expect(refused.status).toBe(400);

    const res = await createForHost({ host_id: booker.id, grant_host_role: true });
    expect(res.status).toBe(201);
    const { data: roles } = await adminClient.from("user_roles").select("role").eq("user_id", booker.id);
    expect(roles?.map((r) => r.role)).toContain("host");
    const granted = await audit("ADMIN_GRANTED_ROLE", booker.id);
    expect(granted.length).toBeGreaterThan(0);
  });

  it("can publish on create, skipping the review queue", async () => {
    const res = await createForHost({ host_id: host.id, status: "published" });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("published");
    await request(app).get(`/v1/locations/${res.body.data.id}`).expect(200);
  });

  it("404s an unknown host and 403s an admin without locations.create", async () => {
    expect((await createForHost({ host_id: randomUUID() })).status).toBe(404);
    expect((await createForHost({ host_id: host.id }, finance)).status).toBe(403);
  });

  it("finds hosts by email for the host picker, flagging who is already a host", async () => {
    const res = await request(app)
      .get("/v1/admin/hosts/search")
      .query({ search: host.email })
      .set(auth(moderator))
      .expect(200);
    expect(res.body.data[0]).toMatchObject({ id: host.id, email: host.email, is_host: true });
    expect(res.body.data[0].location_count).toBeGreaterThan(0);
  });

  it("admin listing rows carry cover_url, host and starting_price", async () => {
    const created = await createForHost({ host_id: host.id, title: `Cover test ${randomUUID().slice(0, 6)}` });
    const id = created.body.data.id as string;
    const { error } = await adminClient.from("location_media").insert({
      location_id: id,
      media_type: "photo",
      storage_key: `locations/${id}/cover-photo/original`,
      position: 0,
    });
    if (error) throw error;
    await request(app)
      .post(`/v1/locations/${id}/pricing`)
      .set(auth(moderator))
      .send({ booking_type: "day", amount_minor_units: 250000 })
      .expect(201);

    const res = await request(app)
      .get("/v1/admin/locations")
      .query({ search: created.body.data.title })
      .set(auth(moderator))
      .expect(200);
    const row = res.body.data.find((l: { id: string }) => l.id === id);
    expect(row.cover_url).toBe(`https://mock-cdn.example.com/locations/${id}/cover-photo/original`);
    expect(row.host).toMatchObject({ id: host.id });
    expect(row.media_count).toBe(1);
    expect(row.starting_price).toMatchObject({ amount_minor_units: 250000, booking_type: "day" });
  });

  it("audits an admin editing a host's pricing/timings through the shared endpoints, not the host doing it", async () => {
    const created = await createForHost({ host_id: host.id });
    const id = created.body.data.id as string;

    await request(app).post(`/v1/locations/${id}/pricing`).set(auth(host)).send({ booking_type: "hourly", amount_minor_units: 5000 }).expect(201);
    expect(await audit("ADMIN_UPDATED_PRICING", id)).toHaveLength(0);

    await request(app)
      .post(`/v1/locations/${id}/availability/rules`)
      .set(auth(moderator))
      .send({ day_of_week: "tuesday", start_time: "08:00", end_time: "20:00" })
      .expect(201);
    const [entry] = await audit("ADMIN_UPDATED_AVAILABILITY", id);
    expect(entry.admin_id).toBe(moderator.id);
    expect(entry.metadata).toMatchObject({ kind: "rule", change: "created", host_id: host.id });
  });

  // -- Catalog covers + listings -------------------------------------------------------------------

  it("sets and removes a category cover through presign -> verify, refusing foreign or missing keys", async () => {
    const createdCat = await request(app)
      .post("/v1/admin/catalog/categories")
      .set(auth(moderator))
      .send({ name: `Rooftops ${randomUUID().slice(0, 6)}`, description: "Open-air city views" })
      .expect(201);
    const catId = createdCat.body.data.id as string;
    categoryIds.push(catId);
    expect(createdCat.body.data.description).toBe("Open-air city views");

    const upload = await request(app)
      .post(`/v1/admin/catalog/categories/${catId}/cover/upload`)
      .set(auth(moderator))
      .send({ content_type: "image/webp", size_bytes: 120_000 })
      .expect(201);
    const key = upload.body.data.storage_key as string;
    expect(key.startsWith(`catalog/categories/${catId}/`)).toBe(true);
    expect(upload.body.data.headers).toEqual({ "Content-Type": "image/webp" });

    // Not uploaded yet.
    await request(app).put(`/v1/admin/catalog/categories/${catId}/cover`).set(auth(moderator)).send({ storage_key: key }).expect(400);
    // Someone else's object.
    await request(app)
      .put(`/v1/admin/catalog/categories/${catId}/cover`)
      .set(auth(moderator))
      .send({ storage_key: `catalog/categories/${randomUUID()}/x.webp` })
      .expect(400);

    r2.objects.set(key, { contentType: "image/webp", contentLength: 120_000 });
    const set = await request(app).put(`/v1/admin/catalog/categories/${catId}/cover`).set(auth(moderator)).send({ storage_key: key }).expect(200);
    expect(set.body.data.cover_url).toBe(`https://mock-cdn.example.com/${key}`);

    const pub = await request(app).get("/v1/categories").expect(200);
    expect(pub.body.data.find((c: { id: string }) => c.id === catId)).toMatchObject({
      cover_url: `https://mock-cdn.example.com/${key}`,
      description: "Open-air city views",
    });

    const removed = await request(app).delete(`/v1/admin/catalog/categories/${catId}/cover`).set(auth(moderator)).expect(200);
    expect(removed.body.data.cover_url).toBeNull();
    expect(r2.deleted.has(key)).toBe(true);
    expect((await audit("ADMIN_UPDATED_CATALOG_COVER", catId)).length).toBe(2);

    const patched = await request(app)
      .patch(`/v1/admin/catalog/categories/${catId}`)
      .set(auth(moderator))
      .send({ description: null })
      .expect(200);
    expect(patched.body.data.description).toBeNull();
  });

  it("adds listings to a catalog item, lists them as cards, and removes one", async () => {
    const cat = await request(app)
      .post("/v1/admin/catalog/categories")
      .set(auth(moderator))
      .send({ name: `Heritage ${randomUUID().slice(0, 6)}` })
      .expect(201);
    const catId = cat.body.data.id as string;
    categoryIds.push(catId);
    const a = (await createForHost({ host_id: host.id, title: "Heritage A" })).body.data.id as string;
    const b = (await createForHost({ host_id: host.id, title: "Heritage B" })).body.data.id as string;

    const added = await request(app)
      .post(`/v1/admin/catalog/categories/${catId}/listings`)
      .set(auth(moderator))
      .send({ location_ids: [a, b] })
      .expect(200);
    expect(added.body.data.added).toBe(2);
    // Idempotent.
    const again = await request(app).post(`/v1/admin/catalog/categories/${catId}/listings`).set(auth(moderator)).send({ location_ids: [a] }).expect(200);
    expect(again.body.data.added).toBe(0);

    const list = await request(app).get(`/v1/admin/catalog/categories/${catId}/listings`).set(auth(finance)).expect(200);
    expect(list.body.meta.total).toBe(2);
    expect(list.body.data.map((l: { title: string }) => l.title).sort()).toEqual(["Heritage A", "Heritage B"]);

    await request(app).delete(`/v1/admin/catalog/categories/${catId}/listings/${a}`).set(auth(moderator)).expect(200);
    await request(app).delete(`/v1/admin/catalog/categories/${catId}/listings/${a}`).set(auth(moderator)).expect(404);
    const after = await request(app).get(`/v1/admin/catalog/categories/${catId}/listings`).set(auth(moderator)).expect(200);
    expect(after.body.data.map((l: { id: string }) => l.id)).toEqual([b]);

    // Finance can look but not touch.
    await request(app).post(`/v1/admin/catalog/categories/${catId}/listings`).set(auth(finance)).send({ location_ids: [a] }).expect(403);
    // The location detail reflects it.
    const detail = await request(app).get(`/v1/admin/locations/${b}`).set(auth(moderator)).expect(200);
    expect(JSON.stringify(detail.body.data)).toContain(catId);
  });

  // -- Collections ---------------------------------------------------------------------------------

  it("runs a collection end to end: create, cover, listings, order, publish, public read, delete", async () => {
    const slug = `goa-villas-${randomUUID().slice(0, 6)}`;
    const created = await request(app)
      .post("/v1/admin/collections")
      .set(auth(moderator))
      .send({ title: "Beach villas in Goa", slug, description: "Sun, sand, story." })
      .expect(201);
    const id = created.body.data.id as string;
    collectionIds.push(id);
    expect(created.body.data).toMatchObject({ is_published: false, listing_count: 0, listings: [] });

    await request(app).post("/v1/admin/collections").set(auth(moderator)).send({ title: "Dup", slug }).expect(409);
    await request(app).post("/v1/admin/collections").set(auth(moderator)).send({ title: "Bad", slug: "Bad Slug" }).expect(400);

    const published = (await createForHost({ host_id: host.id, title: "Villa One", status: "published" })).body.data.id as string;
    const draft = (await createForHost({ host_id: host.id, title: "Villa Draft" })).body.data.id as string;
    const withListings = await request(app)
      .post(`/v1/admin/collections/${id}/listings`)
      .set(auth(moderator))
      .send({ location_ids: [draft, published] })
      .expect(200);
    expect(withListings.body.data.listings.map((l: { id: string }) => l.id)).toEqual([draft, published]);

    const reordered = await request(app)
      .put(`/v1/admin/collections/${id}/listings/order`)
      .set(auth(moderator))
      .send({ ordered_ids: [published, draft] })
      .expect(200);
    expect(reordered.body.data.listings.map((l: { id: string }) => l.id)).toEqual([published, draft]);
    await request(app).put(`/v1/admin/collections/${id}/listings/order`).set(auth(moderator)).send({ ordered_ids: [published] }).expect(400);

    const upload = await request(app)
      .post(`/v1/admin/collections/${id}/cover/upload`)
      .set(auth(moderator))
      .send({ content_type: "image/jpeg", size_bytes: 50_000 })
      .expect(201);
    r2.objects.set(upload.body.data.storage_key, { contentType: "image/jpeg", contentLength: 50_000 });
    const withCover = await request(app)
      .put(`/v1/admin/collections/${id}/cover`)
      .set(auth(moderator))
      .send({ storage_key: upload.body.data.storage_key })
      .expect(200);
    expect(withCover.body.data.cover_url).toContain(`collections/${id}/`);

    // Invisible to the public until published.
    let pub = await request(app).get("/v1/collections").expect(200);
    expect(pub.body.data.map((c: { id: string }) => c.id)).not.toContain(id);
    await request(app).get(`/v1/collections/${slug}`).expect(404);

    await request(app).patch(`/v1/admin/collections/${id}`).set(auth(moderator)).send({ is_published: true }).expect(200);
    pub = await request(app).get("/v1/collections").expect(200);
    expect(pub.body.data.find((c: { id: string }) => c.id === id)).toMatchObject({ slug, listing_count: 1 });

    // Only the published listing is public; by slug and by id.
    const bySlug = await request(app).get(`/v1/collections/${slug}`).expect(200);
    expect(bySlug.body.data.listings.map((l: { id: string }) => l.id)).toEqual([published]);
    await request(app).get(`/v1/collections/${id}`).expect(200);

    await request(app).delete(`/v1/admin/collections/${id}/listings/${draft}`).set(auth(moderator)).expect(200);
    await request(app).delete(`/v1/admin/collections/${id}`).set(auth(finance)).expect(403);
    await request(app).delete(`/v1/admin/collections/${id}`).set(auth(moderator)).expect(200);
    expect(r2.deleted.has(upload.body.data.storage_key)).toBe(true);
    expect((await audit("ADMIN_DELETED_COLLECTION", id)).length).toBe(1);
  });
});

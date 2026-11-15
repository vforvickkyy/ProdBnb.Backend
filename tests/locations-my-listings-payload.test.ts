import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Same R2 stand-in as media.test.ts / media-reorder.test.ts — no real credentials
// needed. `headObject` is what `complete` checks, so an upload is simulated by
// writing into this map. `publicUrlFor` is what the enriched list payload runs
// every storage key through, so the asserted URLs below are this mock's.
const mockObjects = vi.hoisted(() => new Map<string, { contentType: string; contentLength: number }>());

vi.mock("../src/lib/r2", () => ({
  objectKeyFor: (locationId: string, mediaId: string) => `locations/${locationId}/${mediaId}/original`,
  publicUrlFor: (key: string) => `https://mock-cdn.example.com/${key}`,
  presignUpload: async (key: string, contentType: string, contentLength: number) => ({
    url: `https://mock-r2.example.com/${key}?signed=1&ct=${encodeURIComponent(contentType)}&cl=${contentLength}`,
    expiresAt: new Date(Date.now() + 900_000),
  }),
  headObject: async (key: string) => mockObjects.get(key) ?? null,
  deleteObject: async (key: string) => {
    mockObjects.delete(key);
  },
}));

import { createApp } from "../src/app";
import { adminClient, createTestUser, deleteTestUser, grantAdminRole, TestUser } from "./setup";

const app = createApp();
const PHOTO = { media_type: "photo", content_type: "image/jpeg", size_bytes: 1_000_000 };

function authHeader(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${user.accessToken}` };
}

async function grantHostRole(user: TestUser): Promise<void> {
  const res = await request(app).post("/v1/me/roles").set(authHeader(user)).send({ role: "host" });
  expect(res.status).toBe(201);
}

async function createLocation(owner: TestUser, title: string, categoryIds: string[] = []): Promise<string> {
  const body: Record<string, unknown> = { title, city: "London", country: "UK" };
  if (categoryIds.length > 0) body.category_ids = categoryIds;
  const res = await request(app).post("/v1/locations").set(authHeader(owner)).send(body);
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

/** Real seeded category rows, by name — the same helper idiom `locations.test.ts` uses. */
async function categoryIdsFor(names: string[]): Promise<{ id: string; name: string }[]> {
  const { data, error } = await adminClient.from("categories").select("id, name").in("name", names);
  if (error || !data) throw error ?? new Error("Failed to load categories");
  return data as { id: string; name: string }[];
}

/** Authorize → simulate the client's PUT to R2 → complete. Returns the media id. */
async function addPhoto(
  owner: TestUser,
  locationId: string,
  opts: { position?: number; sectionId?: string } = {}
): Promise<string> {
  const upload = await request(app).post(`/v1/locations/${locationId}/media/upload`).set(authHeader(owner)).send(PHOTO);
  expect(upload.status).toBe(201);
  const mediaId = upload.body.data.media_id as string;

  mockObjects.set(`locations/${locationId}/${mediaId}/original`, {
    contentType: PHOTO.content_type,
    contentLength: PHOTO.size_bytes,
  });

  const body: Record<string, unknown> = {};
  if (opts.position !== undefined) body.position = opts.position;
  if (opts.sectionId !== undefined) body.section_id = opts.sectionId;

  const done = await request(app)
    .post(`/v1/locations/${locationId}/media/${mediaId}/complete`)
    .set(authHeader(owner))
    .send(body);
  expect(done.status).toBe(201);
  return mediaId;
}

async function createSection(owner: TestUser, locationId: string, name: string): Promise<string> {
  const res = await request(app).post(`/v1/locations/${locationId}/sections`).set(authHeader(owner)).send({ name });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function addPricing(
  owner: TestUser,
  locationId: string,
  body: Record<string, unknown>
): Promise<string> {
  const res = await request(app).post(`/v1/locations/${locationId}/pricing`).set(authHeader(owner)).send(body);
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

interface ListRow {
  id: string;
  media: { id: string; media_type: string; url: string; position: number }[];
  booking_options: { type: string; amount_minor_units: number; currency: string; is_active: boolean }[];
  categories: { id: string; name: string }[];
  [key: string]: unknown;
}

async function myListings(user: TestUser, query = ""): Promise<{ status: number; rows: ListRow[]; meta: unknown }> {
  const res = await request(app).get(`/v1/me/locations${query}`).set(authHeader(user));
  return { status: res.status, rows: (res.body.data ?? []) as ListRow[], meta: res.body.meta };
}

function rowFor(rows: ListRow[], id: string): ListRow {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`Location ${id} not present in My Listings`);
  return row;
}

describe("Phase 29.18-H/J: GET /v1/me/locations carries media, pricing and categories", () => {
  let host: TestUser;
  let otherHost: TestUser;
  let admin: TestUser;

  // The fully-populated listing: 3 general photos (deliberately NOT inserted in
  // position order), 1 section photo, 1 active + 1 inactive pricing row.
  let richId: string;
  let coverMediaId: string;
  let sectionMediaId: string;

  // Controls.
  let bareId: string;        // no media, no pricing, no categories
  let otherHostsId: string;

  // Phase 29.18-J.
  let twoCategories: { id: string; name: string }[];
  let otherHostCategory: { id: string; name: string }[];
  /** A backend `draft` that is complete by every rule iOS applies — the D-2 fixture. */
  let completeDraftId: string;

  beforeAll(async () => {
    host = await createTestUser();
    otherHost = await createTestUser();
    admin = await createTestUser();
    await grantHostRole(host);
    await grantHostRole(otherHost);
    await grantAdminRole(admin.id);

    richId = await createLocation(host, "29.18-H Rich Listing");

    // Inserted middle-first so a test asserting the cover cannot pass merely
    // because the cover happened to be created first.
    await addPhoto(host, richId, { position: 5 });
    coverMediaId = await addPhoto(host, richId, { position: 1 });
    await addPhoto(host, richId, { position: 9 });

    const sectionId = await createSection(host, richId, "Back Lot");
    // Position 0 — LOWER than every general photo. If section media were not
    // excluded, this would become the listing's cover.
    sectionMediaId = await addPhoto(host, richId, { position: 0, sectionId });

    await addPricing(host, richId, { booking_type: "day", amount_minor_units: 2_500_000, currency: "INR" });
    const inactive = await addPricing(host, richId, {
      booking_type: "hourly",
      amount_minor_units: 400_000,
      currency: "INR",
    });
    const off = await request(app)
      .patch(`/v1/locations/${richId}/pricing/${inactive}`)
      .set(authHeader(host))
      .send({ is_active: false });
    expect(off.status).toBe(200);

    // Phase 29.18-J: the rich listing gets two real categories.
    twoCategories = await categoryIdsFor(["Studio", "Outdoor"]);
    expect(twoCategories).toHaveLength(2);
    const patched = await request(app)
      .patch(`/v1/locations/${richId}`)
      .set(authHeader(host))
      .send({ category_ids: twoCategories.map((c) => c.id) });
    expect(patched.status).toBe(200);

    bareId = await createLocation(host, "29.18-H Bare Listing");
    otherHostCategory = await categoryIdsFor(["Industrial"]);
    otherHostsId = await createLocation(otherHost, "29.18-H Other Host's Listing", [otherHostCategory[0]!.id]);

    // ---- Phase 29.18-J: the D-2 fixture -----------------------------------
    // A backend `draft` that satisfies EVERY rule iOS's completeness check
    // reads: basics (title + >=1 category), address (city/country/lat/lng),
    // description, >=1 general photo, >=1 active pricing row. Left as `draft`
    // deliberately — that is the status whose split D-2 is about.
    completeDraftId = await createLocation(host, "29.18-J Complete Draft", [twoCategories[0]!.id]);
    const completed = await request(app)
      .patch(`/v1/locations/${completeDraftId}`)
      .set(authHeader(host))
      .send({
        description: "A bright rooftop with skyline views, used for film and television production.",
        city: "Mumbai",
        country: "India",
        latitude: 19.0596,
        longitude: 72.8295,
        timezone: "Asia/Kolkata",
        capacity: 25,
      });
    expect(completed.status).toBe(200);
    await addPhoto(host, completeDraftId);
    await addPricing(host, completeDraftId, {
      booking_type: "day",
      amount_minor_units: 1_800_000,
      currency: "INR",
    });
  });

  afterAll(async () => {
    await deleteTestUser(host.id);
    await deleteTestUser(otherHost.id);
    await deleteTestUser(admin.id);
  });

  // --- control -------------------------------------------------------------

  it("control: the fixture really is populated, so nothing below can pass vacuously", async () => {
    const { data } = await adminClient
      .from("location_media")
      .select("id, section_id, position")
      .eq("location_id", richId);
    expect(data).toHaveLength(4);
    expect((data ?? []).filter((m: { section_id: string | null }) => m.section_id === null)).toHaveLength(3);

    const { data: pricing } = await adminClient
      .from("location_pricing")
      .select("booking_type, is_active")
      .eq("location_id", richId);
    expect(pricing).toHaveLength(2);
  });

  // --- 1 & 2: media, and the cover ----------------------------------------

  it("a host's own listing carries its general-gallery media", async () => {
    const { status, rows } = await myListings(host);
    expect(status).toBe(200);
    const row = rowFor(rows, richId);

    expect(row.media).toHaveLength(3);
    for (const m of row.media) {
      expect(m).toEqual({
        id: expect.any(String),
        media_type: "photo",
        url: expect.stringContaining("https://mock-cdn.example.com/"),
        position: expect.any(Number),
        created_at: expect.any(String),
        updated_at: expect.any(String),
      });
    }
  });

  it("the cover can be determined from the lowest media position", async () => {
    const { rows } = await myListings(host);
    const row = rowFor(rows, richId);

    const lowest = row.media.reduce((best, m) => (m.position < best.position ? m : best));
    expect(lowest.id).toBe(coverMediaId);

    // And the array is already position-sorted, so media[0] agrees — a client
    // need not sort to get the same answer.
    expect(row.media[0]!.id).toBe(coverMediaId);
    expect(row.media.map((m) => m.position)).toEqual([1, 5, 9]);
  });

  // --- 3: section media is excluded ---------------------------------------

  it("EXCLUDES section media, even when a section photo has the lowest position of all", async () => {
    const { rows } = await myListings(host);
    const row = rowFor(rows, richId);

    expect(row.media.map((m) => m.id)).not.toContain(sectionMediaId);
    expect(row.media.some((m) => m.position === 0)).toBe(false);
    // The real risk this guards: the section photo silently becoming the cover.
    expect(row.media[0]!.id).toBe(coverMediaId);
  });

  it("a listing whose ONLY photo is a section photo reports no media at all", async () => {
    const id = await createLocation(host, "29.18-H Section-Only Listing");
    const sectionId = await createSection(host, id, "Only Area");
    await addPhoto(host, id, { sectionId });

    const { rows } = await myListings(host);
    expect(rowFor(rows, id).media).toEqual([]);
  });

  // --- 4 & 5: pricing ------------------------------------------------------

  it("carries active pricing", async () => {
    const { rows } = await myListings(host);
    const row = rowFor(rows, richId);

    expect(row.booking_options).toEqual([
      { type: "day", amount_minor_units: 2_500_000, currency: "INR", is_active: true },
    ]);
  });

  it("EXCLUDES inactive pricing — an unbookable tier can never become a starting price", async () => {
    const { rows } = await myListings(host);
    const row = rowFor(rows, richId);

    expect(row.booking_options.map((p) => p.type)).not.toContain("hourly");
    expect(row.booking_options.every((p) => p.is_active)).toBe(true);
  });

  // --- 6 & 7: nothing is fabricated ---------------------------------------

  it("a listing with no media stays valid and fabricates no cover", async () => {
    const { rows } = await myListings(host);
    const row = rowFor(rows, bareId);

    expect(row.media).toEqual([]);
    expect(row.id).toBe(bareId);
    expect(row.title).toBe("29.18-H Bare Listing");
  });

  it("a listing with no pricing stays valid and fabricates no price", async () => {
    const { rows } = await myListings(host);
    expect(rowFor(rows, bareId).booking_options).toEqual([]);
  });

  // --- 8 & 9: authorization ------------------------------------------------

  it("never returns another host's listings", async () => {
    const { rows } = await myListings(host);
    expect(rows.map((r) => r.id)).not.toContain(otherHostsId);

    const { rows: theirs } = await myListings(otherHost);
    expect(theirs.map((r) => r.id)).toContain(otherHostsId);
    expect(theirs.map((r) => r.id)).not.toContain(richId);
  });

  it("leaks no media or pricing belonging to another host's listing", async () => {
    await addPhoto(otherHost, otherHostsId);
    await addPricing(otherHost, otherHostsId, {
      booking_type: "day",
      amount_minor_units: 9_900_000,
      currency: "INR",
    });

    const { rows } = await myListings(host);
    expect(rows.map((r) => r.id)).not.toContain(otherHostsId);
    for (const row of rows) {
      expect(row.booking_options.every((p) => p.amount_minor_units !== 9_900_000)).toBe(true);
    }
  });

  it("an unauthenticated GET /v1/me/locations is still 401", async () => {
    const res = await request(app).get("/v1/me/locations");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  // --- 10: pagination ------------------------------------------------------

  it("preserves pagination and meta.total", async () => {
    const all = await myListings(host);
    const total = (all.meta as { total: number }).total;
    expect(total).toBeGreaterThanOrEqual(3);
    expect(all.rows.length).toBe(total);

    const firstPage = await myListings(host, "?page=1&pageSize=2");
    expect(firstPage.rows).toHaveLength(2);
    expect(firstPage.meta).toMatchObject({ page: 1, pageSize: 2, total });

    const secondPage = await myListings(host, "?page=2&pageSize=2");
    expect(secondPage.meta).toMatchObject({ page: 2, pageSize: 2, total });

    // Paging still slices parent rows, and the embed did not multiply them.
    const ids = new Set([...firstPage.rows, ...secondPage.rows].map((r) => r.id));
    expect(ids.size).toBe(Math.min(4, total));
  });

  it("still orders newest-created first", async () => {
    const { rows } = await myListings(host);
    const created = rows.map((r) => Date.parse(r.created_at as string));
    expect(created).toEqual([...created].sort((a, b) => b - a));
  });

  // --- 11: admin listing unchanged -----------------------------------------

  it("leaves GET /v1/admin/locations completely unchanged — no media, no booking_options", async () => {
    const res = await request(app).get("/v1/admin/locations?pageSize=100").set(authHeader(admin));
    expect(res.status).toBe(200);

    const row = (res.body.data as Record<string, unknown>[]).find((r) => r.id === richId);
    expect(row).toBeDefined();
    // The enrichment is scoped to listMyLocations. If LOCATION_COLUMNS or the
    // shared listLocations() path were widened instead, these would appear here.
    expect(row).not.toHaveProperty("media");
    expect(row).not.toHaveProperty("booking_options");
    expect(row).not.toHaveProperty("location_media");
    expect(row).not.toHaveProperty("location_pricing");
    expect(row).toHaveProperty("title", "29.18-H Rich Listing");
    expect(res.body.meta).toMatchObject({ page: 1, pageSize: 100 });
  });

  // --- 12: storage_key is never exposed ------------------------------------

  it("never exposes storage_key, or any raw embed key, anywhere in the response", async () => {
    const res = await request(app).get("/v1/me/locations").set(authHeader(host));
    expect(res.status).toBe(200);

    // A whole-body string scan: catches the key at any depth, including one
    // added later by a nested embed nobody thought to assert on.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("storage_key");
    expect(serialized).not.toContain("section_id");
    expect(serialized).not.toContain("location_media");
    expect(serialized).not.toContain("location_pricing");
    // The internal R2 path shape must not appear outside a computed public URL.
    for (const row of res.body.data as ListRow[]) {
      for (const m of row.media) {
        expect(m).not.toHaveProperty("storage_key");
        expect(m).not.toHaveProperty("section_id");
        expect(m.url.startsWith("https://mock-cdn.example.com/")).toBe(true);
      }
    }
  });

  // --- shape parity with the detail response -------------------------------

  it("reports the same media and pricing the detail response does", async () => {
    const { rows } = await myListings(host);
    const listRow = rowFor(rows, richId);

    const detail = await request(app).get(`/v1/locations/${richId}`).set(authHeader(host));
    expect(detail.status).toBe(200);

    expect(listRow.media).toEqual(detail.body.data.media);
    expect(listRow.booking_options.map(({ is_active: _ignored, ...rest }) => rest)).toEqual(
      detail.body.data.booking_options
    );
  });

  // =========================================================================
  // Phase 29.18-J — categories, and the D-2 closure
  // =========================================================================

  describe("Phase 29.18-J: categories", () => {
    it("a host's own listing carries its categories", async () => {
      const { rows } = await myListings(host);
      const row = rowFor(rows, richId);

      expect(Array.isArray(row.categories)).toBe(true);
      expect(row.categories).toHaveLength(2);
    });

    it("each category is the existing {id, name} shape — no new representation", async () => {
      const { rows } = await myListings(host);
      const row = rowFor(rows, richId);

      for (const c of row.categories) {
        // Exactly two keys. A `location_id`, a join-row id or a `created_at`
        // leaking in would mean the embed was flattened wrongly.
        expect(Object.keys(c).sort()).toEqual(["id", "name"]);
        expect(typeof c.id).toBe("string");
        expect(typeof c.name).toBe("string");
      }

      const byName = [...row.categories].sort((a, b) => a.name.localeCompare(b.name));
      const expected = [...twoCategories].sort((a, b) => a.name.localeCompare(b.name));
      expect(byName).toEqual(expected);
    });

    it("multiple categories are all preserved, not just the first", async () => {
      const { rows } = await myListings(host);
      const names = rowFor(rows, richId).categories.map((c) => c.name).sort();
      expect(names).toEqual(["Outdoor", "Studio"]);
    });

    it("a listing with no categories stays valid and reports an empty array", async () => {
      const { rows } = await myListings(host);
      const row = rowFor(rows, bareId);

      expect(row.categories).toEqual([]);
      expect(row.title).toBe("29.18-H Bare Listing");
      // Nothing fabricated anywhere else on a bare row either.
      expect(row.media).toEqual([]);
      expect(row.booking_options).toEqual([]);
    });

    it("never leaks another host's listing or its categories", async () => {
      const { rows } = await myListings(host);
      expect(rows.map((r) => r.id)).not.toContain(otherHostsId);

      // "Industrial" is on the other host's listing only. It must appear nowhere.
      for (const row of rows) {
        expect(row.categories.every((c) => c.id !== otherHostCategory[0]!.id)).toBe(true);
        expect(row.categories.every((c) => c.name !== "Industrial")).toBe(true);
      }

      // And the other host does see their own.
      const { rows: theirs } = await myListings(otherHost);
      expect(rowFor(theirs, otherHostsId).categories.map((c) => c.name)).toEqual(["Industrial"]);
    });

    it("reports the same categories the detail response does", async () => {
      const { rows } = await myListings(host);
      const listRow = rowFor(rows, richId);
      const detail = await request(app).get(`/v1/locations/${richId}`).set(authHeader(host));
      expect(detail.status).toBe(200);

      const sortById = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
      expect([...listRow.categories].sort(sortById)).toEqual(
        [...(detail.body.data.categories as { id: string }[])].sort(sortById)
      );
    });

    /**
     * No N+1, stated as the property a client actually depends on: **one**
     * request returns every row fully enriched, so nothing has to be fetched
     * per listing. (That it is also a single *database* query is structural —
     * `listLocations` issues exactly one `.select()` — and is verified by
     * reading the service, not by counting queries from out here.)
     */
    it("one request returns EVERY row fully enriched — no per-listing follow-up", async () => {
      const { status, rows, meta } = await myListings(host);
      expect(status).toBe(200);
      expect(rows.length).toBeGreaterThanOrEqual(4);
      expect(rows.length).toBe((meta as { total: number }).total);

      // Every row carries all three collections — present, correctly typed,
      // never undefined — so a client never needs a second call for any of them.
      for (const row of rows) {
        expect(Array.isArray(row.categories)).toBe(true);
        expect(Array.isArray(row.media)).toBe(true);
        expect(Array.isArray(row.booking_options)).toBe(true);
      }

      // And at least two DIFFERENT rows are genuinely populated, so this cannot
      // pass on a single enriched row surrounded by empty ones.
      const populated = rows.filter(
        (r) => r.categories.length > 0 && r.media.length > 0 && r.booking_options.length > 0
      );
      expect(populated.length).toBeGreaterThanOrEqual(2);
    });

    it("no raw join row or category internals appear anywhere in the response", async () => {
      const res = await request(app).get("/v1/me/locations").set(authHeader(host));
      expect(res.status).toBe(200);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain("location_categories");
      expect(serialized).not.toContain("storage_key");
    });
  });

  // --- D-2 closure ---------------------------------------------------------

  describe("Phase 29.18-J: D-2 — the list payload can now decide completeness", () => {
    /**
     * The backend deliberately computes no completeness. This asserts only that
     * every input iOS's `isBackendReadyToPublish` reads is now present on a list
     * row — basics (title + >=1 category), address, description, >=1 general
     * photo, >=1 active pricing row — which is exactly what 29.18-I could not
     * get and therefore could not close D-2 with.
     */
    it("a complete backend draft carries every field the client's completeness rule reads", async () => {
      const { rows } = await myListings(host);
      const row = rowFor(rows, completeDraftId);

      expect(row.status).toBe("draft");

      // basics
      expect(typeof row.title).toBe("string");
      expect((row.title as string).length).toBeGreaterThanOrEqual(3);
      expect(row.categories.length).toBeGreaterThanOrEqual(1);

      // address
      expect(row.city).toBe("Mumbai");
      expect(row.country).toBe("India");
      expect(row.latitude).toBeCloseTo(19.0596);
      expect(row.longitude).toBeCloseTo(72.8295);
      expect(row.timezone).toBe("Asia/Kolkata");

      // description
      expect((row.description as string).length).toBeGreaterThanOrEqual(50);

      // photos + pricing
      expect(row.media.length).toBeGreaterThanOrEqual(1);
      expect(row.booking_options.length).toBeGreaterThanOrEqual(1);
      expect(row.booking_options.every((p) => p.is_active)).toBe(true);
    });

    it("the list row and the detail response agree on every completeness input", async () => {
      const { rows } = await myListings(host);
      const listRow = rowFor(rows, completeDraftId);
      const detail = await request(app).get(`/v1/locations/${completeDraftId}`).set(authHeader(host));
      expect(detail.status).toBe(200);
      const d = detail.body.data;

      const sortById = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
      expect([...listRow.categories].sort(sortById)).toEqual([...d.categories].sort(sortById));
      expect(listRow.media).toEqual(d.media);
      expect(listRow.booking_options.map(({ is_active: _i, ...rest }) => rest)).toEqual(d.booking_options);
      for (const key of ["title", "description", "city", "country", "latitude", "longitude", "timezone", "status"]) {
        expect(listRow[key]).toEqual(d[key]);
      }
    });

    /**
     * The incomplete counterpart. Without this the test above would pass just as
     * well against a payload that fabricated a category for every row.
     */
    it("an INCOMPLETE draft is visibly incomplete in the same payload", async () => {
      const { rows } = await myListings(host);
      const row = rowFor(rows, bareId);

      expect(row.categories).toEqual([]);
      expect(row.media).toEqual([]);
      expect(row.booking_options).toEqual([]);
    });
  });

  // --- Admin isolation, re-asserted for categories -------------------------

  it("GET /v1/admin/locations is STILL unchanged — no categories either", async () => {
    const res = await request(app).get("/v1/admin/locations?pageSize=100").set(authHeader(admin));
    expect(res.status).toBe(200);

    for (const id of [richId, completeDraftId]) {
      const row = (res.body.data as Record<string, unknown>[]).find((r) => r.id === id);
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty("categories");
      expect(row).not.toHaveProperty("location_categories");
      expect(row).not.toHaveProperty("media");
      expect(row).not.toHaveProperty("booking_options");
      expect(row).not.toHaveProperty("location_media");
      expect(row).not.toHaveProperty("location_pricing");
    }

    // Its own fields and metadata still answer.
    const rich = (res.body.data as Record<string, unknown>[]).find((r) => r.id === richId)!;
    expect(rich.title).toBe("29.18-H Rich Listing");
    expect(rich).toHaveProperty("host_id");
    expect(rich).toHaveProperty("status");
    expect(rich).toHaveProperty("created_at");
    expect(res.body.meta).toMatchObject({ page: 1, pageSize: 100 });

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("location_categories");
    expect(serialized).not.toContain("storage_key");
  });
});

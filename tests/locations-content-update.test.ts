import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { adminClient, createTestUser, deleteTestUser, grantAdminRole, TestUser } from "./setup";

/**
 * Phase 29.18-L — content updates on a PUBLISHED listing.
 *
 * `tests/locations.test.ts` covers creating a location with categories/amenities/use-cases and
 * capacity. What it does not cover is **changing** them afterwards, which is exactly what the
 * Host content editor does — and in particular changing them on a listing that is already live.
 *
 * No backend source changed in this phase. These tests document behaviour that already exists,
 * including the behaviour that is uncomfortable (§"replaceTags is not transactional" below).
 */

const app = createApp();

function authHeader(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${user.accessToken}` };
}

async function grantHostRole(user: TestUser): Promise<void> {
  const res = await request(app).post("/v1/me/roles").set(authHeader(user)).send({ role: "host" });
  expect(res.status).toBe(201);
}

async function catalogIds(table: string, names: string[]): Promise<string[]> {
  const { data, error } = await adminClient.from(table).select("id, name").in("name", names);
  if (error || !data) throw error ?? new Error(`Failed to load ${table}`);
  // Keep the caller's order so a test can name a specific row.
  return names.map((n) => (data as { id: string; name: string }[]).find((r) => r.name === n)!.id);
}

/** A published location owned by `host`, with the given starting tags. */
async function createPublishedLocation(
  host: TestUser,
  title: string,
  tags: { category_ids?: string[]; amenity_ids?: string[]; use_case_ids?: string[]; capacity?: number } = {}
): Promise<string> {
  const res = await request(app)
    .post("/v1/locations")
    .set(authHeader(host))
    .send({ title, city: "Mumbai", country: "India", latitude: 19.0596, longitude: 72.8295, ...tags });
  expect(res.status).toBe(201);
  const id = res.body.data.id as string;

  // Publishing is an admin action; `locations.status` is not grantable to `authenticated`.
  const { error } = await adminClient.from("locations").update({ status: "published" }).eq("id", id);
  expect(error).toBeNull();
  return id;
}

function patchLocation(user: TestUser, id: string, body: unknown) {
  return request(app).patch(`/v1/locations/${id}`).set(authHeader(user)).send(body);
}

async function detail(user: TestUser, id: string) {
  const res = await request(app).get(`/v1/locations/${id}`).set(authHeader(user));
  expect(res.status).toBe(200);
  return res.body.data as {
    capacity: number | null;
    status: string;
    title: string;
    categories: { id: string; name: string }[];
    amenities: { id: string; name: string }[];
    use_cases: { id: string; name: string }[];
  };
}

const names = (rows: { name: string }[]) => rows.map((r) => r.name).sort();

describe("Phase 29.18-L: content updates on a published listing", () => {
  let host: TestUser;
  let otherHost: TestUser;
  let admin: TestUser;

  let studio: string;
  let outdoor: string;
  let office: string;
  let parking: string;
  let power: string;
  let film: string;

  beforeAll(async () => {
    host = await createTestUser();
    otherHost = await createTestUser();
    admin = await createTestUser();
    await grantHostRole(host);
    await grantHostRole(otherHost);
    await grantAdminRole(admin.id);

    [studio, outdoor, office] = await catalogIds("categories", ["Studio", "Outdoor", "Office"]);
    [parking, power] = await catalogIds("amenities", ["Parking", "Power"]);
    [film] = await catalogIds("use_cases", ["Film"]);
  });

  afterAll(async () => {
    await deleteTestUser(host.id);
    await deleteTestUser(otherHost.id);
    await deleteTestUser(admin.id);
  });

  // --- the point of the phase -------------------------------------------

  it("lets a host change all four content fields on a PUBLISHED listing", async () => {
    const id = await createPublishedLocation(host, "29.18-L Published", {
      category_ids: [studio!],
      capacity: 10,
    });

    const res = await patchLocation(host, id, {
      capacity: 45,
      category_ids: [outdoor!, office!],
      amenity_ids: [parking!, power!],
      use_case_ids: [film!],
    });
    expect(res.status).toBe(200);

    const after = await detail(host, id);
    expect(after.status).toBe("published");
    expect(after.capacity).toBe(45);
    expect(names(after.categories)).toEqual(["Office", "Outdoor"]);
    expect(names(after.amenities)).toEqual(["Parking", "Power"]);
    expect(names(after.use_cases)).toEqual(["Film"]);
  });

  it("does not change the listing's status as a side effect", async () => {
    const id = await createPublishedLocation(host, "29.18-L Status Untouched", { category_ids: [studio!] });
    expect((await patchLocation(host, id, { capacity: 12 })).status).toBe(200);
    expect((await detail(host, id)).status).toBe("published");
  });

  // --- replaceTags semantics ---------------------------------------------

  it("REPLACES a tag set rather than appending to it", async () => {
    const id = await createPublishedLocation(host, "29.18-L Replace", { category_ids: [studio!, outdoor!] });
    expect(names((await detail(host, id)).categories)).toEqual(["Outdoor", "Studio"]);

    expect((await patchLocation(host, id, { category_ids: [office!] })).status).toBe(200);
    expect(names((await detail(host, id)).categories)).toEqual(["Office"]);
  });

  it("an empty array clears that set and leaves the others untouched", async () => {
    const id = await createPublishedLocation(host, "29.18-L Clear One", {
      category_ids: [studio!],
      amenity_ids: [parking!],
      use_case_ids: [film!],
    });

    expect((await patchLocation(host, id, { category_ids: [] })).status).toBe(200);

    const after = await detail(host, id);
    expect(after.categories).toEqual([]);
    expect(names(after.amenities)).toEqual(["Parking"]);
    expect(names(after.use_cases)).toEqual(["Film"]);
  });

  it("an OMITTED array is left completely alone", async () => {
    const id = await createPublishedLocation(host, "29.18-L Omit", {
      category_ids: [studio!],
      amenity_ids: [parking!],
    });

    // Only capacity is sent. The two tag sets must survive untouched.
    expect((await patchLocation(host, id, { capacity: 30 })).status).toBe(200);

    const after = await detail(host, id);
    expect(after.capacity).toBe(30);
    expect(names(after.categories)).toEqual(["Studio"]);
    expect(names(after.amenities)).toEqual(["Parking"]);
  });

  it("reordering the same ids is not a content change", async () => {
    const id = await createPublishedLocation(host, "29.18-L Reorder", { category_ids: [studio!, outdoor!] });
    expect((await patchLocation(host, id, { category_ids: [outdoor!, studio!] })).status).toBe(200);
    expect(names((await detail(host, id)).categories)).toEqual(["Outdoor", "Studio"]);
  });

  // --- R-1: replaceTags is NOT transactional -----------------------------

  /**
   * **This test documents a real defect, not a desired behaviour.**
   *
   * `replaceTags` is `DELETE … ; INSERT …` as two separate statements with no transaction. When
   * the insert fails — here, on a category id that does not exist — the delete has **already
   * committed**, so the location is left with *no* categories even though the request was
   * rejected with a 400.
   *
   * Phase 29.18-L mitigates this client-side (send only arrays whose membership changed; on any
   * failure re-read and report the true state, never "Saved"). The real fix is a transactional
   * `replace_location_tags()` RPC, which is deliberately a separate future backend phase.
   *
   * If a future phase makes the replacement atomic, **this test should fail** — and the correct
   * response is to change the assertion to `["Studio"]`, not to delete the test.
   */
  it("R-1: a failed insert leaves the set already deleted — the 400 is not a rollback", async () => {
    const id = await createPublishedLocation(host, "29.18-L R-1", { category_ids: [studio!] });
    expect(names((await detail(host, id)).categories)).toEqual(["Studio"]);

    const res = await patchLocation(host, id, {
      category_ids: ["00000000-0000-0000-0000-000000000000"],
    });
    expect(res.status).toBe(400);

    const after = await detail(host, id);
    expect(after.categories).toEqual([]);
    expect(after.title).toBe("29.18-L R-1");
  });

  it("R-1: an earlier array can be applied while a later one fails in the same request", async () => {
    const id = await createPublishedLocation(host, "29.18-L R-1 Partial", {
      category_ids: [studio!],
      amenity_ids: [parking!],
    });

    // Categories are replaced first and succeed; amenities then fail on a bad id.
    const res = await patchLocation(host, id, {
      category_ids: [outdoor!],
      amenity_ids: ["00000000-0000-0000-0000-000000000000"],
    });
    expect(res.status).toBe(400);

    const after = await detail(host, id);
    expect(names(after.categories)).toEqual(["Outdoor"]);
    expect(after.amenities).toEqual([]);
  });

  // --- capacity -----------------------------------------------------------

  it("capacity can be cleared to null and set again", async () => {
    const id = await createPublishedLocation(host, "29.18-L Capacity", { capacity: 25 });
    expect((await detail(host, id)).capacity).toBe(25);

    expect((await patchLocation(host, id, { capacity: null })).status).toBe(200);
    expect((await detail(host, id)).capacity).toBeNull();

    expect((await patchLocation(host, id, { capacity: 60 })).status).toBe(200);
    expect((await detail(host, id)).capacity).toBe(60);
  });

  it("rejects a zero or negative capacity", async () => {
    const id = await createPublishedLocation(host, "29.18-L Capacity Invalid", { capacity: 25 });
    for (const capacity of [0, -5]) {
      expect((await patchLocation(host, id, { capacity })).status).toBe(400);
    }
    expect((await detail(host, id)).capacity).toBe(25);
  });

  /**
   * The consequence the iOS editor warns about: the search RPC filters with
   * `l.capacity >= _capacity_min`, and under three-valued logic a NULL never satisfies it.
   */
  it("a null capacity removes the listing from a crew-size search", async () => {
    const id = await createPublishedLocation(host, "29.18-L Crew Size", { capacity: 50 });

    const withCapacity = await request(app).get("/v1/locations?capacity_min=10&pageSize=100");
    expect(withCapacity.status).toBe(200);
    expect((withCapacity.body.data as { id: string }[]).some((l) => l.id === id)).toBe(true);

    expect((await patchLocation(host, id, { capacity: null })).status).toBe(200);

    const without = await request(app).get("/v1/locations?capacity_min=10&pageSize=100");
    expect((without.body.data as { id: string }[]).some((l) => l.id === id)).toBe(false);
    // …but it is still published and still findable without that filter.
    const unfiltered = await request(app).get("/v1/locations?pageSize=100");
    expect((unfiltered.body.data as { id: string }[]).some((l) => l.id === id)).toBe(true);
  });

  // --- limits -------------------------------------------------------------

  it("enforces the catalog array limits", async () => {
    const id = await createPublishedLocation(host, "29.18-L Limits");
    const tooMany = (n: number) => Array.from({ length: n }, () => studio!);

    expect((await patchLocation(host, id, { category_ids: tooMany(21) })).status).toBe(400);
    // 60: amenities and location rules share one list since the listing-details round.
    expect((await patchLocation(host, id, { amenity_ids: tooMany(61) })).status).toBe(400);
    expect((await patchLocation(host, id, { use_case_ids: tooMany(11) })).status).toBe(400);
  });

  it("rejects an unknown field — the schema is strict", async () => {
    const id = await createPublishedLocation(host, "29.18-L Strict");
    expect((await patchLocation(host, id, { house_rules: "No smoking" })).status).toBe(400);
  });

  // --- authorization ------------------------------------------------------

  it("forbids another host from changing this listing's content", async () => {
    const id = await createPublishedLocation(host, "29.18-L Other Host", { category_ids: [studio!] });

    const res = await patchLocation(otherHost, id, { capacity: 99, category_ids: [office!] });
    expect(res.status).toBe(403);

    const after = await detail(host, id);
    expect(after.capacity).toBeNull();
    expect(names(after.categories)).toEqual(["Studio"]);
  });

  it("requires authentication", async () => {
    const id = await createPublishedLocation(host, "29.18-L Anon");
    const res = await request(app).patch(`/v1/locations/${id}`).send({ capacity: 99 });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("lets an admin change content on a listing they do not own", async () => {
    const id = await createPublishedLocation(host, "29.18-L Admin");
    expect((await patchLocation(admin, id, { capacity: 15 })).status).toBe(200);
    expect((await detail(host, id)).capacity).toBe(15);
  });

  // --- nothing else moved --------------------------------------------------

  it("leaves pricing and media completely untouched", async () => {
    const id = await createPublishedLocation(host, "29.18-L Isolation", { category_ids: [studio!] });
    const priced = await request(app)
      .post(`/v1/locations/${id}/pricing`)
      .set(authHeader(host))
      .send({ booking_type: "day", amount_minor_units: 2_500_000, currency: "INR" });
    expect(priced.status).toBe(201);

    expect((await patchLocation(host, id, { capacity: 20, category_ids: [office!] })).status).toBe(200);

    const pricing = await request(app).get(`/v1/locations/${id}/pricing`).set(authHeader(host));
    expect(pricing.status).toBe(200);
    expect(pricing.body.data).toHaveLength(1);
    expect(pricing.body.data[0].amount_minor_units).toBe(2_500_000);
    expect(pricing.body.data[0].is_active).toBe(true);
  });

  it("GET /v1/admin/locations still carries no categories, media or booking_options", async () => {
    const id = await createPublishedLocation(host, "29.18-L Admin Payload", { category_ids: [studio!] });
    const res = await request(app).get("/v1/admin/locations?pageSize=100").set(authHeader(admin));
    expect(res.status).toBe(200);

    const row = (res.body.data as Record<string, unknown>[]).find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("categories");
    expect(row).not.toHaveProperty("media");
    expect(row).not.toHaveProperty("booking_options");
  });
});

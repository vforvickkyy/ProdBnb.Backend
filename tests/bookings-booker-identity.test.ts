import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

// Phase 29.18-F — a host may see WHO booked their listing, and nothing else about them.
//
// The defect, measured before this phase: `profiles` RLS is own-row-or-admin (Phase 1), so the
// `booker:profiles!booker_id (...)` embed in BOOKING_DETAIL_SELECT resolves to null for a host.
// PostgREST applies RLS to an embedded resource independently of the parent row, so the booking
// survived and the person did not. `booker_id` was never lost -- only the name.
//
// `get_booking_participants()` is the fix: SECURITY DEFINER, gated on
// `locations.host_id = auth.uid()`, returning exactly booking_id/id/first_name/last_name/avatar_url.
//
// These tests exercise the real HTTP surface and the real function. Nothing writes a status column
// directly to fake a state.

const app = createApp();

function authHeader(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${user.accessToken}` };
}

async function grantRole(user: TestUser, role: "host" | "booker"): Promise<void> {
  const res = await request(app).post("/v1/me/roles").set(authHeader(user)).send({ role });
  expect(res.status).toBe(201);
}

async function setProfile(
  user: TestUser,
  fields: { first_name?: string | null; last_name?: string | null; avatar_url?: string | null }
): Promise<void> {
  const { error } = await adminClient.from("profiles").update(fields).eq("id", user.id);
  if (error) throw error;
}

async function bookableLocation(owner: TestUser, title: string): Promise<string> {
  const created = await request(app).post("/v1/locations").set(authHeader(owner)).send({
    title,
    city: "Chail",
    country: "India",
    timezone: "UTC",
  });
  expect(created.status).toBe(201);
  const id = created.body.data.id as string;

  for (const day of ["monday", "tuesday", "wednesday"]) {
    const rule = await request(app)
      .post(`/v1/locations/${id}/availability/rules`)
      .set(authHeader(owner))
      .send({ day_of_week: day, start_time: "09:00", end_time: "18:00" });
    expect(rule.status).toBe(201);
  }
  const pricing = await request(app)
    .post(`/v1/locations/${id}/pricing`)
    .set(authHeader(owner))
    .send({ booking_type: "hourly", amount_minor_units: 10_000 });
  expect(pricing.status).toBe(201);

  const { error } = await adminClient.from("locations").update({ status: "published" }).eq("id", id);
  if (error) throw error;
  return id;
}

/**
 * Records a settled payment so the booking becomes visible in the HOST list.
 *
 * The Phase 29.14-D gate makes `GET /v1/bookings?host_id=` join `payments!inner` on a settled
 * status, so an unpaid booking is invisible to its host by design — this test discovered that the
 * hard way. The gate itself is **not** under test here (that is
 * `tests/bookings-payment-gate.test.ts`, which drives the real signed Cashfree webhook precisely
 * because faking a status column would prove nothing about it). This writes the row directly only
 * to reach the state whose *identity* payload is under test. Nothing about the gate is modified.
 */
async function settlePayment(bookingId: string): Promise<void> {
  const { error } = await adminClient.from("payments").insert({
    booking_id: bookingId,
    provider: "cashfree",
    provider_order_id: `test-order-${bookingId}`,
    status: "success",
    amount_minor_units: 20_000,
    currency: "INR",
  });
  if (error) throw error;
}

/** 2026-10-05 is a Monday, -06 Tuesday, -07 Wednesday. */
async function book(booker: TestUser, locationId: string, date: string, hour = 10): Promise<string> {
  const res = await request(app)
    .post("/v1/bookings")
    .set(authHeader(booker))
    .send({
      location_id: locationId,
      booking_type: "hourly",
      start_at: `${date}T${String(hour).padStart(2, "0")}:00:00+00:00`,
      end_at: `${date}T${String(hour + 2).padStart(2, "0")}:00:00+00:00`,
    });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

/** Calls the function as a given user, exactly as the service does. */
async function callAsUser(user: TestUser, bookingIds: string[]): Promise<Record<string, unknown>[]> {
  const res = await request(app).get("/v1/bookings").set(authHeader(user)).query({ pageSize: 1 });
  expect(res.status).toBe(200); // the session is valid
  const { createClient } = await import("@supabase/supabase-js");
  const { env } = await import("../src/config/env");
  const scoped = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${user.accessToken}` } },
  });
  const { data, error } = await scoped.rpc("get_booking_participants", { _booking_ids: bookingIds });
  if (error) throw error;
  return (data ?? []) as Record<string, unknown>[];
}

describe("Phase 29.18-F: a host sees who booked their listing", () => {
  let hostA: TestUser;
  let hostB: TestUser;
  let booker: TestUser;
  let namelessBooker: TestUser;
  let locationA: string;
  let locationB: string;
  let bookingA: string;   // on hostA's listing, by `booker`
  let bookingB: string;   // on hostB's listing
  let namelessBooking: string;

  beforeAll(async () => {
    hostA = await createTestUser();
    hostB = await createTestUser();
    booker = await createTestUser();
    namelessBooker = await createTestUser();

    await grantRole(hostA, "host");
    await grantRole(hostB, "host");
    await grantRole(booker, "booker");
    await grantRole(namelessBooker, "booker");

    await setProfile(booker, {
      first_name: "Asha",
      last_name: "Rao",
      avatar_url: "https://example.test/storage/v1/object/public/avatars/asha.jpg",
    });
    // Deliberately no names: the "no name on file" case must return a row, not vanish.
    await setProfile(namelessBooker, { first_name: null, last_name: null, avatar_url: null });

    locationA = await bookableLocation(hostA, "Host A Studio");
    locationB = await bookableLocation(hostB, "Host B Studio");

    bookingA = await book(booker, locationA, "2026-10-05");
    bookingB = await book(booker, locationB, "2026-10-06");
    namelessBooking = await book(namelessBooker, locationA, "2026-10-07");

    // Host-visible requires a settled payment (29.14-D). `bookingB` is deliberately left unpaid —
    // nothing below needs it in a list, and leaving it unpaid keeps the gate's behaviour visible.
    await settlePayment(bookingA);
    await settlePayment(namelessBooking);
  }, 120_000);

  afterAll(async () => {
    await deleteTestUser(hostA.id);
    await deleteTestUser(hostB.id);
    await deleteTestUser(booker.id);
    await deleteTestUser(namelessBooker.id);
  });

  // --- control -------------------------------------------------------------
  // Without this, every security assertion below could pass simply because the
  // booking did not exist.
  it("CONTROL: the authorized host's booking really exists and is visible to them", async () => {
    const rows = await callAsUser(hostA, [bookingA]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.booking_id).toBe(bookingA);
  });

  // --- the happy path ------------------------------------------------------
  it("the host of the booking gets the booker's name and avatar", async () => {
    const rows = await callAsUser(hostA, [bookingA]);
    expect(rows[0]!.id).toBe(booker.id);
    expect(rows[0]!.first_name).toBe("Asha");
    expect(rows[0]!.last_name).toBe("Rao");
    expect(rows[0]!.avatar_url).toContain("asha.jpg");
  });

  it("one call answers for a whole page of bookings, not one per row", async () => {
    const rows = await callAsUser(hostA, [bookingA, namelessBooking]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.booking_id))).toEqual(new Set([bookingA, namelessBooking]));
  });

  // --- the authorization boundary -----------------------------------------
  it("a DIFFERENT host gets nothing for a booking that is not on their listing", async () => {
    expect(await callAsUser(hostB, [bookingA])).toHaveLength(0);
  });

  it("a host asking for every booking id still only gets their own", async () => {
    const rows = await callAsUser(hostA, [bookingA, bookingB, namelessBooking]);
    expect(rows.map((r) => r.booking_id).sort()).toEqual([bookingA, namelessBooking].sort());
    expect(rows.some((r) => r.booking_id === bookingB)).toBe(false);
  });

  it("the BOOKER themselves gets nothing — this is not a booker-facing lookup", async () => {
    expect(await callAsUser(booker, [bookingA])).toHaveLength(0);
  });

  it("an unauthenticated caller gets nothing", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const { env } = await import("../src/config/env");
    const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await anon.rpc("get_booking_participants", { _booking_ids: [bookingA] });
    // Either EXECUTE is refused outright or it fails closed to zero rows. Both are acceptable;
    // returning the booker is not.
    if (!error) {
      expect(data ?? []).toHaveLength(0);
    }
  });

  // --- privacy -------------------------------------------------------------
  it("exposes exactly five keys and no private profile column", async () => {
    const rows = await callAsUser(hostA, [bookingA]);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ["avatar_url", "booking_id", "first_name", "id", "last_name"].sort()
    );
    const serialized = JSON.stringify(rows[0]);
    for (const forbidden of ["phone", "address", "status", "email", "created_at", "updated_at"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("a booker with no name on file returns a row of nulls, not a missing row", async () => {
    const rows = await callAsUser(hostA, [namelessBooking]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(namelessBooker.id);
    expect(rows[0]!.first_name).toBeNull();
    expect(rows[0]!.last_name).toBeNull();
  });

  // --- the API surface -----------------------------------------------------
  it("GET /v1/bookings carries booker_profile for the host", async () => {
    const res = await request(app).get("/v1/bookings").set(authHeader(hostA)).query({ host_id: hostA.id, pageSize: 50 });
    expect(res.status).toBe(200);
    const row = (res.body.data as Record<string, any>[]).find((b) => b.id === bookingA);
    expect(row).toBeDefined();
    expect(row!.booker_profile).toMatchObject({ id: booker.id, first_name: "Asha", last_name: "Rao" });
    // The pre-existing embed is untouched and still null for a host — it was not removed.
    expect(row!.booker_id).toBe(booker.id);
  });

  it("GET /v1/bookings/:id carries booker_profile for the host", async () => {
    const res = await request(app).get(`/v1/bookings/${bookingA}`).set(authHeader(hostA));
    expect(res.status).toBe(200);
    expect(res.body.data.booker_profile).toMatchObject({ id: booker.id, first_name: "Asha" });
  });

  it("the BOOKER's own booking response carries no booker_profile", async () => {
    const res = await request(app).get(`/v1/bookings/${bookingA}`).set(authHeader(booker));
    expect(res.status).toBe(200);
    expect(res.body.data.booker_profile).toBeUndefined();
    // …but their own `booker` embed still works, which is why it was not removed.
    expect(res.body.data.booker).not.toBeNull();
  });

  it("a different host cannot read the booking at all, let alone its booker", async () => {
    const res = await request(app).get(`/v1/bookings/${bookingA}`).set(authHeader(hostB));
    expect(res.status).toBe(404);
  });

  // --- regression ----------------------------------------------------------
  it("GET /v1/admin/bookings is unchanged — no booker_profile is introduced there", async () => {
    // hostA is not an admin, so this is the authorization shape, not the payload.
    const res = await request(app).get("/v1/admin/bookings").set(authHeader(hostA));
    expect(res.status).toBe(403);
  });

  it("the 29.14-D ordering contract is unchanged", async () => {
    const res = await request(app).get("/v1/bookings").set(authHeader(hostA)).query({ host_id: hostA.id, pageSize: 50 });
    expect(res.status).toBe(200);
    const created = (res.body.data as Record<string, any>[]).map((b) => b.created_at);
    // Non-vacuous: hostA has two settled bookings, so there is a real order to check.
    expect(created.length).toBeGreaterThanOrEqual(2);
    expect([...created].sort().reverse()).toEqual(created);
  });

  it("the 29.14-D payment gate still hides an UNPAID booking from its host", async () => {
    // `bookingB` is hostB's and unpaid. Proven from hostB's own list, so this is the gate and not
    // merely the ownership check.
    const res = await request(app).get("/v1/bookings").set(authHeader(hostB)).query({ host_id: hostB.id, pageSize: 50 });
    expect(res.status).toBe(200);
    expect((res.body.data as Record<string, any>[]).some((b) => b.id === bookingB)).toBe(false);
  });
});

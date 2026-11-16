import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

const app = createApp();
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.accessToken}` });

// 2027-03-01 is a Monday: far enough ahead never to be "in the past".
const MON = "2027-03-01";
const TUE = "2027-03-02";
const SUN = "2027-02-28";

describe("booking quote (website checkout)", () => {
  let host: TestUser;
  let booker: TestUser;
  let plain: TestUser;
  let locationId: string;

  beforeAll(async () => {
    host = await createTestUser();
    booker = await createTestUser();
    plain = await createTestUser();
    expect((await request(app).post("/v1/me/roles").set(auth(host)).send({ role: "host" })).status).toBe(201);
    expect((await request(app).post("/v1/me/roles").set(auth(booker)).send({ role: "booker" })).status).toBe(201);
    const created = await request(app).post("/v1/locations").set(auth(host)).send({ title: "Quote studio", city: "Mumbai", country: "India", timezone: "Asia/Kolkata" });
    expect(created.status).toBe(201);
    locationId = created.body.data.id;
    for (const day of ["monday", "tuesday"]) {
      expect((await request(app).post(`/v1/locations/${locationId}/availability/rules`).set(auth(host)).send({ day_of_week: day, start_time: "09:00", end_time: "18:00" })).status).toBe(201);
    }
    for (const body of [
      { booking_type: "hourly", amount_minor_units: 150_000 },
      { booking_type: "half_day", amount_minor_units: 400_000, half_day_duration_hours: 4 },
      { booking_type: "multi_day", amount_minor_units: 900_000 },
    ]) {
      expect((await request(app).post(`/v1/locations/${locationId}/pricing`).set(auth(host)).send(body)).status).toBe(201);
    }
    await adminClient.from("locations").update({ status: "published" }).eq("id", locationId);
    await adminClient.from("platform_settings").update({ platform_fee_bps: 500, tax_bps: 1800 }).eq("singleton", true);
  });

  afterAll(async () => {
    await adminClient.from("platform_settings").update({ platform_fee_bps: 0, tax_bps: 0 }).eq("singleton", true);
    await adminClient.from("bookings").delete().eq("location_id", locationId);
    await adminClient.from("locations").delete().eq("id", locationId);
    for (const u of [host, booker, plain]) await deleteTestUser(u.id);
  });

  it("prices an hourly booking exactly as booking it would, without creating anything", async () => {
    const body = { location_id: locationId, booking_type: "hourly", start_at: `${MON}T10:00:00+05:30`, end_at: `${MON}T13:00:00+05:30` };
    const quote = await request(app).post("/v1/bookings/quote").set(auth(plain)).send(body);
    expect(quote.status).toBe(200);
    expect(quote.body.data).toMatchObject({
      available: true,
      reason: null,
      units: { count: 3, unit: "hour" },
      rate_minor_units: 150_000,
      instant_booking: false,
      own_listing: false,
      timezone: "Asia/Kolkata",
    });
    const { count } = await adminClient.from("bookings").select("id", { count: "exact", head: true }).eq("location_id", locationId);
    expect(count).toBe(0);

    const booked = await request(app).post("/v1/bookings").set(auth(booker)).send(body);
    expect(booked.status).toBe(201);
    expect(quote.body.data.pricing).toEqual({ ...booked.body.data.pricing, discount_minor_units: 0 });
    expect(quote.body.data.pricing).toMatchObject({ base_amount_minor_units: 450_000, platform_fee_minor_units: 22_500, total_amount_minor_units: 450_000 + 22_500 + 85_050 });

    // The same time again is now taken.
    const again = await request(app).post("/v1/bookings/quote").set(auth(plain)).send(body);
    expect(again.body.data.available).toBe(false);
    expect(again.body.data.reason).toMatch(/already booked/);
    expect(again.body.data.pricing).not.toBeNull();
  });

  it("derives the half-day end and the multi-day span", async () => {
    const half = await request(app).post("/v1/bookings/quote").set(auth(booker)).send({ location_id: locationId, booking_type: "half_day", start_at: `${TUE}T09:00:00+05:30` });
    expect(half.body.data).toMatchObject({ available: true, units: { count: 1, unit: "half_day" } });
    expect(new Date(half.body.data.end_at).getTime() - new Date(half.body.data.start_at).getTime()).toBe(4 * 3_600_000);

    const multi = await request(app).post("/v1/bookings/quote").set(auth(booker)).send({ location_id: locationId, booking_type: "multi_day", start_date: "2027-03-08", end_date: "2027-03-09" });
    expect(multi.status).toBe(200);
    expect(multi.body.data.units).toEqual({ count: 2, unit: "day" });
    expect(multi.body.data.pricing.base_amount_minor_units).toBe(1_800_000);
  });

  it("explains times and types that can't be booked", async () => {
    const closed = await request(app).post("/v1/bookings/quote").set(auth(booker)).send({ location_id: locationId, booking_type: "hourly", start_at: `${SUN}T10:00:00+05:30`, end_at: `${SUN}T12:00:00+05:30` });
    expect(closed.body.data.available).toBe(false);

    const noDay = await request(app).post("/v1/bookings/quote").set(auth(booker)).send({ location_id: locationId, booking_type: "day", date: MON });
    expect(noDay.body.data).toMatchObject({ available: false, reason: "This place doesn't offer that kind of booking.", pricing: null });

    const past = await request(app).post("/v1/bookings/quote").set(auth(booker)).send({ location_id: locationId, booking_type: "hourly", start_at: "2026-01-05T10:00:00+05:30", end_at: "2026-01-05T12:00:00+05:30" });
    expect(past.body.data).toMatchObject({ available: false, reason: "That time has already passed." });
  });

  it("tells a host it's their own listing, and needs a signed-in caller", async () => {
    const own = await request(app).post("/v1/bookings/quote").set(auth(host)).send({ location_id: locationId, booking_type: "hourly", start_at: `${TUE}T14:00:00+05:30`, end_at: `${TUE}T16:00:00+05:30` });
    expect(own.body.data.own_listing).toBe(true);
    const anon = await request(app).post("/v1/bookings/quote").send({ location_id: locationId, booking_type: "hourly", start_at: `${TUE}T14:00:00+05:30`, end_at: `${TUE}T16:00:00+05:30` });
    expect(anon.status).toBe(401);
  });
});

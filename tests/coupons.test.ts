import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { discountFor } from "../src/modules/coupons/coupons.service";
import { hostEarnings } from "../src/modules/payouts/earnings.service";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

const app = createApp();
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.accessToken}` });
const stamp = Date.now().toString(36).toUpperCase().slice(-5);

describe("coupons and offers", () => {
  let host: TestUser;
  let otherHost: TestUser;
  let booker: TestUser;
  let booker2: TestUser;
  let finance: TestUser;
  let support: TestUser;
  let locationId: string;
  let otherLocationId: string;
  let hour = 0;
  const created: string[] = [];

  async function role(u: TestUser, r: "host" | "booker") {
    expect((await request(app).post("/v1/me/roles").set(auth(u)).send({ role: r })).status).toBe(201);
  }
  async function admin(u: TestUser, teamRole: "finance" | "support") {
    await adminClient.from("user_roles").insert({ user_id: u.id, role: "admin" });
    await adminClient.from("admin_team_members").update({ team_role: teamRole }).eq("user_id", u.id);
  }
  async function listing(owner: TestUser): Promise<string> {
    const res = await request(app).post("/v1/locations").set(auth(owner)).send({ title: "Coupon studio", city: "Mumbai", country: "India", timezone: "Asia/Kolkata" });
    const id = res.body.data.id as string;
    expect((await request(app).post(`/v1/locations/${id}/availability/rules`).set(auth(owner)).send({ day_of_week: "monday", start_time: "06:00", end_time: "23:00" })).status).toBe(201);
    expect((await request(app).post(`/v1/locations/${id}/pricing`).set(auth(owner)).send({ booking_type: "hourly", amount_minor_units: 100_000 })).status).toBe(201);
    await adminClient.from("locations").update({ status: "published" }).eq("id", id);
    return id;
  }
  // Two-hour slots on Mondays (the only open day), never overlapping.
  const slot = () => {
    const n = hour++;
    const monday = new Date(Date.UTC(2027, 2, 1 + 7 * Math.floor(n / 7))).toISOString().slice(0, 10);
    const h = 6 + 2 * (n % 7);
    return { start_at: `${monday}T${String(h).padStart(2, "0")}:00:00+05:30`, end_at: `${monday}T${String(h + 2).padStart(2, "0")}:00:00+05:30` };
  };
  const quote = (u: TestUser, code: string, loc = locationId) => request(app).post("/v1/bookings/quote").set(auth(u)).send({ location_id: loc, booking_type: "hourly", ...slot(), coupon_code: code });
  async function book(u: TestUser, code: string, pay = true): Promise<{ status: number; body: { data: { id: string; pricing: Record<string, number> }; error?: { message: string } } }> {
    const res = await request(app).post("/v1/bookings").set(auth(u)).send({ location_id: locationId, booking_type: "hourly", ...slot(), coupon_code: code });
    if (res.status === 201 && pay) {
      await adminClient.from("payments").insert({ booking_id: res.body.data.id, provider: "cashfree", provider_order_id: `pb_cp_${res.body.data.id.replace(/-/g, "")}`, status: "success", amount_minor_units: res.body.data.pricing.total_amount_minor_units, currency: "INR" });
    }
    return res;
  }

  beforeAll(async () => {
    [host, otherHost, booker, booker2, finance, support] = await Promise.all(Array.from({ length: 6 }, () => createTestUser()));
    await Promise.all([role(host, "host"), role(otherHost, "host"), role(booker, "booker"), role(booker2, "booker")]);
    await admin(finance, "finance");
    await admin(support, "support");
    locationId = await listing(host);
    otherLocationId = await listing(otherHost);
    await adminClient.from("platform_settings").update({ platform_fee_bps: 1000, tax_bps: 1800 }).eq("singleton", true);
  });

  afterAll(async () => {
    await adminClient.from("platform_settings").update({ platform_fee_bps: 0, tax_bps: 0 }).eq("singleton", true);
    const { data: bookings } = await adminClient.from("bookings").select("id").in("location_id", [locationId, otherLocationId]);
    const ids = (bookings ?? []).map((b: { id: string }) => b.id);
    if (ids.length) {
      await adminClient.from("coupon_redemptions").delete().in("booking_id", ids);
      await adminClient.from("payments").delete().in("booking_id", ids);
      await adminClient.from("bookings").delete().in("id", ids);
    }
    await adminClient.from("coupons").delete().in("id", created);
    await adminClient.from("locations").delete().in("id", [locationId, otherLocationId]);
    for (const u of [host, otherHost, booker, booker2, finance, support]) await deleteTestUser(u.id);
  });

  it("works out percentage (capped) and fixed discounts, never above the price", () => {
    expect(discountFor({ discount_type: "percent", percent_off: 20, amount_off_minor_units: null, max_discount_minor_units: null }, 200_000)).toBe(40_000);
    expect(discountFor({ discount_type: "percent", percent_off: 20, amount_off_minor_units: null, max_discount_minor_units: 25_000 }, 200_000)).toBe(25_000);
    expect(discountFor({ discount_type: "fixed", percent_off: null, amount_off_minor_units: 500_000, max_discount_minor_units: null }, 200_000)).toBe(200_000);
  });

  it("lets finance create ProdBnb coupons, not support", async () => {
    const body = { code: `PB${stamp}`, title: "ProdBnb 20% off", discount_type: "percent", percent_off: 20, max_discount_minor_units: 30_000, is_public: true };
    expect((await request(app).post("/v1/admin/coupons").set(auth(support)).send(body)).status).toBe(403);
    const res = await request(app).post("/v1/admin/coupons").set(auth(finance)).send(body);
    expect(res.status).toBe(201);
    created.push(res.body.data.id);
    expect(res.body.data).toMatchObject({ owner_type: "platform", status: "active", uses: 0 });
    expect((await request(app).post("/v1/admin/coupons").set(auth(finance)).send(body)).status).toBe(409);
  });

  it("takes a ProdBnb coupon off the listing price, works out fee and tax on the rest, and leaves the host's earning whole", async () => {
    const q = await quote(booker, `pb${stamp}`.toLowerCase());
    expect(q.body.data.coupon).toMatchObject({ code: `PB${stamp}`, discount_minor_units: 30_000, funded_by: "platform" });
    // ₹2,000 for 2 hours, ₹300 off (20% capped at ₹300) → fee 10% of 1,700 = 170, tax 18% of 1,870 = 336.60
    expect(q.body.data.pricing).toMatchObject({ base_amount_minor_units: 200_000, discount_minor_units: 30_000, platform_fee_minor_units: 17_000, tax_minor_units: 33_660, total_amount_minor_units: 220_660 });

    const res = await book(booker, `PB${stamp}`);
    expect(res.status).toBe(201);
    expect(res.body.data.pricing.total_amount_minor_units).toBe(220_660);
    const { data: row } = await adminClient.from("bookings").select("discount_minor_units, discount_funded_by, coupon_id").eq("id", res.body.data.id).single();
    expect(row).toMatchObject({ discount_minor_units: 30_000, discount_funded_by: "platform", coupon_id: created[0] });
    const earning = (await hostEarnings(host.id)).rows.find((r) => r.booking_id === res.body.data.id)!;
    expect(earning.net_minor_units).toBe(200_000);
  });

  it("lets a host run their own coupon on their own listings, paid out of their earning", async () => {
    expect((await request(app).post("/v1/me/coupons").set(auth(host)).send({ code: `HX${stamp}`, title: "Nope", discount_type: "fixed", amount_off_minor_units: 10_000, location_ids: [otherLocationId] })).status).toBe(400);
    const res = await request(app).post("/v1/me/coupons").set(auth(host)).send({ code: `HOST${stamp}`, title: "₹500 off", discount_type: "fixed", amount_off_minor_units: 50_000, location_ids: [locationId], is_public: true });
    expect(res.status).toBe(201);
    created.push(res.body.data.id);
    expect(res.body.data).toMatchObject({ owner_type: "host", host_id: host.id, location_ids: [locationId] });

    // Doesn't work at someone else's place.
    expect((await quote(booker, `HOST${stamp}`, otherLocationId)).body.data).toMatchObject({ coupon: null, coupon_error: "That code doesn't apply to this place." });

    const booked = await book(booker, `HOST${stamp}`);
    expect(booked.status).toBe(201);
    const earning = (await hostEarnings(host.id)).rows.find((r) => r.booking_id === booked.body.data.id)!;
    expect(earning).toMatchObject({ listing_price_minor_units: 200_000, host_discount_minor_units: 50_000, net_minor_units: 150_000 });

    // Other hosts can't see or touch it; a used coupon can't be deleted.
    expect((await request(app).get(`/v1/me/coupons/${res.body.data.id}`).set(auth(otherHost))).status).toBe(404);
    expect((await request(app).delete(`/v1/me/coupons/${res.body.data.id}`).set(auth(host))).status).toBe(409);
    const mine = await request(app).get("/v1/me/coupons").set(auth(host));
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0]).toMatchObject({ uses: 1, discount_given_minor_units: 50_000 });
  });

  it("explains why a code doesn't apply", async () => {
    const make = async (extra: Record<string, unknown>) => {
      const code = `T${stamp}${created.length}`;
      const res = await request(app).post("/v1/admin/coupons").set(auth(finance)).send({ code, title: "Test", discount_type: "fixed", amount_off_minor_units: 10_000, ...extra });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      created.push(res.body.data.id);
      return code;
    };
    expect((await quote(booker, "NOSUCHCODE")).body.data.coupon_error).toBe("That code isn't valid.");
    expect((await quote(booker, await make({ is_active: false }))).body.data.coupon_error).toBe("That code isn't valid.");
    expect((await quote(booker, await make({ ends_at: "2026-01-01T00:00:00Z" }))).body.data.coupon_error).toBe("That offer has ended.");
    expect((await quote(booker, await make({ min_booking_minor_units: 500_000 }))).body.data.coupon_error).toMatch(/at least ₹5,000/);
    expect((await quote(booker, await make({ booking_types: ["day"] }))).body.data.coupon_error).toMatch(/hourly bookings/);
    expect((await quote(booker, await make({ first_booking_only: true }))).body.data.coupon_error).toBe("That code is for your first booking.");
    expect((await quote(booker2, created.length ? `T${stamp}${created.length - 1}` : "")).body.data.coupon).not.toBeNull();

    const once = await make({ per_user_limit: 1 });
    expect((await book(booker2, once)).status).toBe(201);
    expect((await quote(booker2, once)).body.data.coupon_error).toBe("You've already used that code.");
    // Booking with a code that no longer applies is refused.
    expect((await book(booker2, once)).status).toBe(400);

    const limited = await make({ usage_limit: 1 });
    expect((await book(booker, limited)).status).toBe(201);
    expect((await quote(booker2, limited)).body.data.coupon_error).toBe("That code has been fully used.");
  });

  it("shows public offers on the listing and the Offers page, and usage to admins", async () => {
    const offers = await request(app).get(`/v1/locations/${locationId}/offers`);
    expect(offers.body.data.map((o: { code: string }) => o.code)).toEqual(expect.arrayContaining([`PB${stamp}`, `HOST${stamp}`]));
    const elsewhere = await request(app).get(`/v1/locations/${otherLocationId}/offers`);
    expect(elsewhere.body.data.map((o: { code: string }) => o.code)).not.toContain(`HOST${stamp}`);
    const all = await request(app).get("/v1/offers");
    expect(all.body.data.find((o: { code: string }) => o.code === `HOST${stamp}`).locations[0].id).toBe(locationId);

    const detail = await request(app).get(`/v1/admin/coupons/${created[0]}`).set(auth(support));
    expect(detail.status).toBe(200);
    expect(detail.body.data.redemptions).toHaveLength(1);
    expect(detail.body.data.redemptions[0]).toMatchObject({ discount_minor_units: 30_000, funded_by: "platform", booking: { paid: true } });
    const list = await request(app).get("/v1/admin/coupons?owner=host").set(auth(support));
    expect(list.body.data.every((c: { owner_type: string }) => c.owner_type === "host")).toBe(true);
  });
});

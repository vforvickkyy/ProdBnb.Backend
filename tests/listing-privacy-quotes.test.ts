import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { anonClient } from "../src/lib/supabase";
import { adminClient, createTestUser, deleteTestUser, grantAdminRole, TestUser } from "./setup";

const app = createApp();
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.accessToken}` });

const REAL = { latitude: 18.53, longitude: 73.89 };

/** Metres between two points (equirectangular -- plenty at these distances). */
function metresBetween(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const x = ((b.longitude - a.longitude) * Math.PI) / 180 * Math.cos((((a.latitude + b.latitude) / 2) * Math.PI) / 180);
  const y = ((b.latitude - a.latitude) * Math.PI) / 180;
  return Math.sqrt(x * x + y * y) * 6_371_000;
}

describe("listing address privacy, price on request, shoot details", () => {
  let host: TestUser;
  let booker: TestUser;
  let booker2: TestUser;
  let admin: TestUser;
  let privateId: string;
  let requestId: string;
  let musicVideo: string;
  const bookingIds: string[] = [];

  async function listing(title: string, extra: Record<string, unknown> = {}): Promise<string> {
    const created = await request(app)
      .post("/v1/locations")
      .set(auth(host))
      .send({
        title,
        city: "Pune",
        country: "India",
        area: "Koregaon Park",
        address_line1: "12 Lane 5, Koregaon Park",
        postal_code: "411001",
        ...REAL,
        timezone: "Asia/Kolkata",
        ...extra,
      });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    expect((await request(app).post(`/v1/locations/${id}/availability/rules`).set(auth(host)).send({ day_of_week: "monday", start_time: "09:00", end_time: "18:00" })).status).toBe(201);
    await adminClient.from("locations").update({ status: "published" }).eq("id", id);
    return id;
  }

  beforeAll(async () => {
    [host, booker, booker2, admin] = await Promise.all([createTestUser(), createTestUser(), createTestUser(), createTestUser()]);
    expect((await request(app).post("/v1/me/roles").set(auth(host)).send({ role: "host" })).status).toBe(201);
    for (const b of [booker, booker2]) {
      expect((await request(app).post("/v1/me/roles").set(auth(b)).send({ role: "booker" })).status).toBe(201);
    }
    await grantAdminRole(admin.id);
    const { data: useCase } = await adminClient.from("use_cases").upsert({ name: "Music Video" }, { onConflict: "name" }).select("id").single();
    musicVideo = useCase!.id as string;

    privateId = await listing("Privacy villa");
    expect((await request(app).post(`/v1/locations/${privateId}/pricing`).set(auth(host)).send({ booking_type: "hourly", amount_minor_units: 100_000 })).status).toBe(201);

    requestId = await listing("Quote studio", { price_on_request: true });
    // A type with no price is still requestable on a price-on-request listing.
    expect((await request(app).post(`/v1/locations/${requestId}/pricing`).set(auth(host)).send({ booking_type: "hourly", amount_minor_units: 0 })).status).toBe(201);
  });

  afterAll(async () => {
    await adminClient.from("notifications").delete().in("entity_id", bookingIds);
    await adminClient.from("payments").delete().in("booking_id", bookingIds);
    await adminClient.from("bookings").delete().in("id", bookingIds);
    await adminClient.from("locations").delete().in("id", [privateId, requestId]);
    for (const u of [host, booker, booker2, admin]) await deleteTestUser(u.id);
  });

  describe("address privacy", () => {
    it("shows everyone else the area and an approximate point, never the street or real pin", async () => {
      for (const res of [await request(app).get(`/v1/locations/${privateId}`), await request(app).get(`/v1/locations/${privateId}`).set(auth(booker))]) {
        expect(res.status).toBe(200);
        const l = res.body.data;
        expect(l).toMatchObject({ area: "Koregaon Park", city: "Pune", address_line1: null, address_line2: null, postal_code: null });
        expect(l).toMatchObject({ location_precision: "approximate", approximate_radius_m: 2000 });
        const offset = metresBetween(REAL, l);
        expect(offset).toBeGreaterThan(550);
        expect(offset).toBeLessThan(1450);
        expect(JSON.stringify(l)).not.toContain("Lane 5");
      }
    });

    it("keeps the same approximate point between reads and edits that don't move the pin", async () => {
      const first = (await request(app).get(`/v1/locations/${privateId}`)).body.data;
      expect((await request(app).patch(`/v1/locations/${privateId}`).set(auth(host)).send({ description: "Now with a pool." })).status).toBe(200);
      const second = (await request(app).get(`/v1/locations/${privateId}`)).body.data;
      expect([second.latitude, second.longitude]).toEqual([first.latitude, first.longitude]);
    });

    it("shows the host and the team the full address and real pin", async () => {
      for (const u of [host, admin]) {
        const l = (await request(app).get(`/v1/locations/${privateId}`).set(auth(u))).body.data;
        expect(l).toMatchObject({ address_line1: "12 Lane 5, Koregaon Park", postal_code: "411001", ...REAL, location_precision: "exact" });
      }
    });

    it("keeps the private columns away from the public API key too", async () => {
      const { error } = await anonClient.from("locations").select("latitude, address_line1").eq("id", privateId);
      expect(error?.message).toMatch(/permission denied/);
      const { data } = await anonClient.from("locations").select("id, area, public_latitude").eq("id", privateId).single();
      expect(data).toMatchObject({ id: privateId, area: "Koregaon Park" });
    });

    it("lets only the team show the exact location before booking", async () => {
      expect((await request(app).patch(`/v1/locations/${privateId}`).set(auth(host)).send({ show_exact_location: true })).status).toBe(400);
      const res = await request(app).patch(`/v1/admin/locations/${privateId}`).set(auth(admin)).send({ show_exact_location: true, reason: "Famous place" });
      expect(res.status).toBe(200);
      const pub = (await request(app).get(`/v1/locations/${privateId}`)).body.data;
      expect(pub).toMatchObject({ address_line1: "12 Lane 5, Koregaon Park", ...REAL, location_precision: "exact", approximate_radius_m: null });
      const { data: audit } = await adminClient
        .from("admin_audit_log")
        .select("action, metadata")
        .eq("target_id", privateId)
        .eq("action", "ADMIN_UPDATED_LOCATION")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      expect((audit!.metadata as { fields: string[] }).fields).toContain("show_exact_location");

      await request(app).patch(`/v1/admin/locations/${privateId}`).set(auth(admin)).send({ show_exact_location: false });
      const hidden = (await request(app).get(`/v1/locations/${privateId}`)).body.data;
      expect(hidden.address_line1).toBeNull();
      expect(hidden.location_precision).toBe("approximate");
    });
  });

  describe("shoot details", () => {
    it("records what the shoot is, who's on set and the terms, and shows them to the host", async () => {
      const booked = await request(app)
        .post("/v1/bookings")
        .set(auth(booker))
        .send({
          location_id: privateId,
          booking_type: "hourly",
          start_at: "2027-03-01T10:00:00+05:30",
          end_at: "2027-03-01T12:00:00+05:30",
          shoot_type_id: musicVideo,
          crew_size: 18,
          project_name: "Monsoon Song",
          production_name: "",
          shoot_notes: "Two cameras, one drone.",
          accept_terms: true,
        });
      expect(booked.status).toBe(201);
      bookingIds.push(booked.body.data.id);
      expect(booked.body.data.shoot).toMatchObject({
        type_id: musicVideo,
        type: "Music Video",
        crew_size: 18,
        project_name: "Monsoon Song",
        production_name: null,
        notes: "Two cameras, one drone.",
      });
      expect(booked.body.data.shoot.terms_accepted_at).toBeTruthy();
      expect(booked.body.data.pricing_status).toBe("priced");

      const asHost = await request(app).get(`/v1/bookings/${booked.body.data.id}`).set(auth(host));
      expect(asHost.body.data.shoot.type).toBe("Music Video");
    });

    it("rejects a shoot type that isn't on the list, or both a type and own words", async () => {
      const base = { location_id: privateId, booking_type: "hourly", start_at: "2027-03-08T10:00:00+05:30", end_at: "2027-03-08T12:00:00+05:30" };
      const unknown = await request(app).post("/v1/bookings").set(auth(booker)).send({ ...base, shoot_type_id: "00000000-0000-4000-8000-000000000000" });
      expect(unknown.status).toBe(400);
      const both = await request(app).post("/v1/bookings").set(auth(booker)).send({ ...base, shoot_type_id: musicVideo, shoot_type_other: "Fashion film" });
      expect(both.status).toBe(400);
    });
  });

  describe("prices the team manages", () => {
    it("shows the team a paused price as paused, not missing (so it isn't added twice)", async () => {
      const { data: row } = await adminClient.from("location_pricing").select("id").eq("location_id", privateId).eq("booking_type", "hourly").single();
      await adminClient.from("location_pricing").update({ is_active: false }).eq("id", row!.id);
      try {
        const asAdmin = await request(app).get(`/v1/locations/${privateId}/pricing`).set(auth(admin));
        expect(asAdmin.body.data).toEqual([expect.objectContaining({ booking_type: "hourly", is_active: false })]);
        const asBooker = await request(app).get(`/v1/locations/${privateId}/pricing`).set(auth(booker));
        expect(asBooker.body.data).toEqual([]);
      } finally {
        await adminClient.from("location_pricing").update({ is_active: true }).eq("id", row!.id);
      }
    });
  });

  describe("price on request", () => {
    const slot = { booking_type: "hourly", start_at: "2027-03-15T10:00:00+05:30", end_at: "2027-03-15T14:00:00+05:30" };
    let first: string;
    let second: string;

    it("hides the listing's prices from bookers and search", async () => {
      const l = (await request(app).get(`/v1/locations/${requestId}`)).body.data;
      expect(l).toMatchObject({ price_on_request: true, booking_options: [], bookable_options: [{ type: "hourly" }] });
      const pricing = await request(app).get(`/v1/locations/${requestId}/pricing`);
      expect(pricing.body.data ?? []).toEqual([]);
      const search = await request(app).get("/v1/locations").query({ search: "Quote studio", pageSize: 10 });
      const card = search.body.data.find((c: { id: string }) => c.id === requestId);
      expect(card).toMatchObject({ price_on_request: true, starting_price: null, area: "Koregaon Park" });
    });

    it("previews a request without a price", async () => {
      const q = await request(app).post("/v1/bookings/quote").set(auth(booker)).send({ location_id: requestId, ...slot });
      expect(q.status).toBe(200);
      expect(q.body.data).toMatchObject({ available: true, price_on_request: true, pricing: null });
    });

    it("needs the shoot type and people on set, and takes no codes", async () => {
      expect((await request(app).post("/v1/bookings").set(auth(booker)).send({ location_id: requestId, ...slot })).status).toBe(400);
      expect((await request(app).post("/v1/bookings").set(auth(booker)).send({ location_id: requestId, ...slot, shoot_type_other: "Podcast", crew_size: 4, coupon_code: "SAVE10" })).status).toBe(400);
    });

    it("sends a request with no price that tells the host and doesn't hold the slot", async () => {
      const a = await request(app)
        .post("/v1/bookings")
        .set(auth(booker))
        .send({ location_id: requestId, ...slot, shoot_type_other: "Podcast", crew_size: 4, accept_terms: true });
      expect(a.status).toBe(201);
      first = a.body.data.id;
      bookingIds.push(first);
      expect(a.body.data).toMatchObject({ status: "requested", pricing_status: "awaiting_quote", pricing: { total_amount_minor_units: 0 } });

      const { data: note } = await adminClient.from("notifications").select("title").eq("user_id", host.id).eq("entity_id", first).single();
      expect(note!.title).toBe("New price request");

      // A second booker can ask for the same time.
      const b = await request(app)
        .post("/v1/bookings")
        .set(auth(booker2))
        .send({ location_id: requestId, ...slot, shoot_type_id: musicVideo, crew_size: 30 });
      expect(b.status).toBe(201);
      second = b.body.data.id;
      bookingIds.push(second);

      // The host sees both straight away, unpaid.
      const list = await request(app).get("/v1/bookings").query({ host_id: host.id, pageSize: 50 }).set(auth(host));
      expect(list.body.data.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([first, second]));
    });

    it("won't take payment before the host has priced it", async () => {
      const res = await request(app).post(`/v1/bookings/${first}/payments`).set(auth(booker)).send({});
      expect([400, 404]).toContain(res.status);
    });

    it("lets only the host price it; the price gets the platform fee and tax like any booking", async () => {
      expect((await request(app).post(`/v1/bookings/${first}/send-quote`).set(auth(booker)).send({ amount_minor_units: 500_000 })).status).toBe(403);
      expect((await request(app).post(`/v1/bookings/${first}/confirm`).set(auth(host))).status).toBe(400);

      const res = await request(app).post(`/v1/bookings/${first}/send-quote`).set(auth(host)).send({ amount_minor_units: 500_000 });
      expect(res.status).toBe(200);
      const b = res.body.data;
      expect(b).toMatchObject({ status: "confirmed", pricing_status: "quoted" });
      expect(b.quoted_at).toBeTruthy();
      expect(b.pricing.base_amount_minor_units).toBe(500_000);
      expect(b.pricing.total_amount_minor_units).toBe(
        b.pricing.base_amount_minor_units + b.pricing.platform_fee_minor_units + b.pricing.tax_minor_units
      );
      const { data: note } = await adminClient.from("notifications").select("title").eq("user_id", booker.id).eq("entity_id", first).single();
      expect(note!.title).toBe("Your price is ready");
    });

    it("now holds the slot: the overlapping request can't be priced, only declined", async () => {
      const res = await request(app).post(`/v1/bookings/${second}/send-quote`).set(auth(host)).send({ amount_minor_units: 400_000 });
      expect(res.status).toBe(409);
      const declined = await request(app).post(`/v1/bookings/${second}/reject`).set(auth(host)).send({ reason: "Already booked" });
      expect(declined.status).toBe(200);
      expect(declined.body.data.status).toBe("rejected");
    });

    it("stays requestable with every price switched off (or none set): hourly, full day and multi-day", async () => {
      const id = await listing("Quote barn", { price_on_request: true });
      try {
        const l = (await request(app).get(`/v1/locations/${id}`)).body.data;
        expect(l.bookable_options).toEqual([{ type: "hourly" }, { type: "day" }, { type: "multi_day" }]);
        const res = await request(app)
          .post("/v1/bookings")
          .set(auth(booker))
          .send({ location_id: id, booking_type: "day", date: "2027-03-22", shoot_type_other: "Fashion film", crew_size: 6 });
        expect(res.status).toBe(201);
        bookingIds.push(res.body.data.id);
        expect(res.body.data).toMatchObject({ pricing_status: "awaiting_quote", pricing: { currency: "INR" } });
      } finally {
        await adminClient.from("bookings").delete().eq("location_id", id);
        await adminClient.from("locations").delete().eq("id", id);
      }
    });

    it("can't be priced twice", async () => {
      expect((await request(app).post(`/v1/bookings/${first}/send-quote`).set(auth(host)).send({ amount_minor_units: 1_000 })).status).toBe(400);
    });

    it("closes a request the host never priced once its time has passed", async () => {
      const { data: stale } = await adminClient
        .from("bookings")
        .insert({
          location_id: requestId,
          booker_id: booker.id,
          booking_type: "hourly",
          start_at: "2020-01-06T04:30:00Z",
          end_at: "2020-01-06T06:30:00Z",
          status: "requested",
          pricing_status: "awaiting_quote",
          base_amount_minor_units: 0,
          platform_fee_minor_units: 0,
          tax_minor_units: 0,
          discount_minor_units: 0,
          total_amount_minor_units: 0,
          currency: "INR",
        })
        .select("id")
        .single();
      bookingIds.push(stale!.id as string);
      await adminClient.rpc("expire_unpaid_bookings", { _location_id: requestId });
      const { data: after } = await adminClient.from("bookings").select("status, cancellation_reason").eq("id", stale!.id).single();
      expect(after).toMatchObject({ status: "cancelled", cancellation_reason: "The host did not send a price before the booking time." });
    });
  });
});

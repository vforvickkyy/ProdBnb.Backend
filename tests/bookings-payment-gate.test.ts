import { createHmac, randomUUID } from "crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../src/config/env";
import { createApp } from "../src/app";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

// Phase 29.14-D — a host must not learn about a booking until it has been paid for.
//
// Settlement is driven through the REAL signed Cashfree webhook, not by flipping a status column:
// the whole point of the gate is that only the provider's own authoritative result opens it, so a
// test that wrote `status = 'success'` directly would prove nothing about the path that matters.

const app = createApp();
const WEBHOOK_PATH = "/v1/payments/webhooks/cashfree";
const HOST_REQUEST_TYPE = "booking_request_received";

function authHeader(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${user.accessToken}` };
}

async function grantRole(user: TestUser, role: "host" | "booker"): Promise<void> {
  const res = await request(app).post("/v1/me/roles").set(authHeader(user)).send({ role });
  expect(res.status).toBe(201);
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

/** Seeds a live (unsettled) attempt, exactly as a real `initiatePayment` would leave one. */
async function seedPendingPayment(bookingId: string, amountMinorUnits = 20_000) {
  const id = randomUUID();
  const providerOrderId = `pb_${id.replace(/-/g, "")}`;
  const { error } = await adminClient.from("payments").insert({
    id,
    booking_id: bookingId,
    provider: "cashfree",
    provider_order_id: providerOrderId,
    status: "pending",
    amount_minor_units: amountMinorUnits,
    currency: "INR",
  });
  if (error) throw error;
  return { id, providerOrderId, amountMinorUnits };
}

/** Delivers a genuine, correctly-signed PAYMENT_SUCCESS webhook. */
async function deliverPaymentSuccess(providerOrderId: string, amountMinorUnits: number) {
  const payload = {
    type: "PAYMENT_SUCCESS_WEBHOOK",
    event_time: new Date().toISOString(),
    data: {
      order: { order_id: providerOrderId, order_amount: amountMinorUnits / 100, order_currency: "INR" },
      payment: {
        cf_payment_id: `cf_${providerOrderId}`,
        payment_status: "SUCCESS",
        payment_amount: amountMinorUnits / 100,
        payment_currency: "INR",
      },
    },
  };
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", env.CASHFREE_SECRET_KEY).update(timestamp + rawBody).digest("base64");
  return request(app)
    .post(WEBHOOK_PATH)
    .set("Content-Type", "application/json")
    .set("x-webhook-timestamp", timestamp)
    .set("x-webhook-signature", signature)
    .send(rawBody);
}

async function hostBookingIds(host: TestUser, hostId: string): Promise<string[]> {
  const res = await request(app).get("/v1/bookings").set(authHeader(host)).query({ host_id: hostId, pageSize: 100 });
  expect(res.status).toBe(200);
  return (res.body.data as { id: string }[]).map((b) => b.id);
}

async function hostRequestNotificationCount(hostId: string, bookingId: string): Promise<number> {
  const { data, error } = await adminClient
    .from("notifications")
    .select("id")
    .eq("user_id", hostId)
    .eq("type", HOST_REQUEST_TYPE)
    .eq("entity_id", bookingId);
  if (error) throw error;
  return (data ?? []).length;
}

describe("Phase 29.14-D: host sees a booking only after payment is confirmed", () => {
  let host: TestUser;
  let booker: TestUser;
  let locationId: string;

  beforeAll(async () => {
    host = await createTestUser();
    booker = await createTestUser();
    await grantRole(host, "host");
    await grantRole(booker, "booker");
    locationId = await bookableLocation(host, "Payment Gate Location");
  });

  afterAll(async () => {
    await deleteTestUser(host.id);
    await deleteTestUser(booker.id);
  });

  // ---- unpaid is invisible -------------------------------------------------

  it("does NOT return an unpaid booking from the host query", async () => {
    const bookingId = await book(booker, locationId, "2026-10-05", 9);
    expect(await hostBookingIds(host, host.id)).not.toContain(bookingId);
  });

  it("does NOT create a host notification when the booking is created", async () => {
    const bookingId = await book(booker, locationId, "2026-10-05", 12);
    // The defect this phase fixes: this used to be 1, fired from createBooking() before any
    // payment existed at all.
    expect(await hostRequestNotificationCount(host.id, bookingId)).toBe(0);
  });

  it("still returns the booker's OWN unpaid booking — that is how they get back to paying", async () => {
    const bookingId = await book(booker, locationId, "2026-10-05", 15);
    const res = await request(app).get("/v1/bookings").set(authHeader(booker)).query({ booker_id: booker.id, pageSize: 100 });
    expect(res.status).toBe(200);
    expect((res.body.data as { id: string }[]).map((b) => b.id)).toContain(bookingId);
  });

  it("does NOT return a booking whose payment is merely in flight", async () => {
    const bookingId = await book(booker, locationId, "2026-10-06", 9);
    await seedPendingPayment(bookingId);
    expect(await hostBookingIds(host, host.id)).not.toContain(bookingId);
  });

  it("refuses a host confirm on an unpaid booking", async () => {
    const bookingId = await book(booker, locationId, "2026-10-06", 12);
    const res = await request(app).post(`/v1/bookings/${bookingId}/confirm`).set(authHeader(host)).send({});
    expect(res.status).toBe(400);
  });

  it("refuses a host reject on an unpaid booking", async () => {
    const bookingId = await book(booker, locationId, "2026-10-06", 15);
    const res = await request(app).post(`/v1/bookings/${bookingId}/reject`).set(authHeader(host)).send({});
    expect(res.status).toBe(400);
  });

  // ---- payment opens the gate ---------------------------------------------

  it("becomes host-visible and raises exactly one host request once payment settles", async () => {
    const bookingId = await book(booker, locationId, "2026-10-07", 9);
    const payment = await seedPendingPayment(bookingId);

    expect(await hostBookingIds(host, host.id)).not.toContain(bookingId);
    expect(await hostRequestNotificationCount(host.id, bookingId)).toBe(0);

    const hook = await deliverPaymentSuccess(payment.providerOrderId, payment.amountMinorUnits);
    expect(hook.status).toBe(200);

    expect(await hostBookingIds(host, host.id)).toContain(bookingId);
    expect(await hostRequestNotificationCount(host.id, bookingId)).toBe(1);
  });

  it("is idempotent: a redelivered webhook creates no duplicate request or notification", async () => {
    const bookingId = await book(booker, locationId, "2026-10-07", 12);
    const payment = await seedPendingPayment(bookingId);

    expect((await deliverPaymentSuccess(payment.providerOrderId, payment.amountMinorUnits)).status).toBe(200);
    expect(await hostRequestNotificationCount(host.id, bookingId)).toBe(1);

    // Three more deliveries, exactly as a retrying provider would send.
    for (let i = 0; i < 3; i += 1) {
      expect((await deliverPaymentSuccess(payment.providerOrderId, payment.amountMinorUnits)).status).toBe(200);
    }

    expect(await hostRequestNotificationCount(host.id, bookingId)).toBe(1);
    expect((await hostBookingIds(host, host.id)).filter((id) => id === bookingId)).toHaveLength(1);
  });

  it("lets the host approve after payment, and the booking becomes confirmed", async () => {
    const bookingId = await book(booker, locationId, "2026-10-07", 15);
    const payment = await seedPendingPayment(bookingId);
    expect((await deliverPaymentSuccess(payment.providerOrderId, payment.amountMinorUnits)).status).toBe(200);

    const res = await request(app).post(`/v1/bookings/${bookingId}/confirm`).set(authHeader(host)).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("confirmed");
  });

  it("lets the host reject after payment, and the booking becomes rejected", async () => {
    const bookingId = await book(booker, locationId, "2026-10-12", 9);
    const payment = await seedPendingPayment(bookingId);
    expect((await deliverPaymentSuccess(payment.providerOrderId, payment.amountMinorUnits)).status).toBe(200);

    const res = await request(app).post(`/v1/bookings/${bookingId}/reject`).set(authHeader(host)).send({ reason: "no" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("rejected");
    // No refund is issued automatically — the money is owed back, not returned. The Booker UI says
    // "Refund Initiated", never "Refunded".
    const { data } = await adminClient.from("payments").select("status").eq("booking_id", bookingId).single();
    expect(data?.status).toBe("success");
  });

  it("keeps a paid booking visible to the host after it is cancelled", async () => {
    const bookingId = await book(booker, locationId, "2026-10-12", 12);
    const payment = await seedPendingPayment(bookingId);
    expect((await deliverPaymentSuccess(payment.providerOrderId, payment.amountMinorUnits)).status).toBe(200);

    const cancel = await request(app).post(`/v1/bookings/${bookingId}/cancel`).set(authHeader(booker)).send({});
    expect(cancel.status).toBe(200);
    expect(await hostBookingIds(host, host.id)).toContain(bookingId);
  });

  it("still returns the location thumbnail on a host-visible paid booking", async () => {
    const { error } = await adminClient.from("location_media").insert({
      location_id: locationId,
      media_type: "photo",
      storage_key: "locations/gate/cover.jpg",
      position: 0,
      section_id: null,
    });
    if (error) throw error;

    const bookingId = await book(booker, locationId, "2026-10-13", 9);
    const payment = await seedPendingPayment(bookingId);
    expect((await deliverPaymentSuccess(payment.providerOrderId, payment.amountMinorUnits)).status).toBe(200);

    const res = await request(app).get("/v1/bookings").set(authHeader(host)).query({ host_id: host.id, pageSize: 100 });
    const found = (res.body.data as { id: string; location: { primary_media_url: string | null } }[])
      .find((b) => b.id === bookingId);
    expect(found?.location.primary_media_url).toContain("locations/gate/cover.jpg");
  });
});

describe("Phase 29.14-D: bookings are ordered newest-first by created_at", () => {
  let host: TestUser;
  let booker: TestUser;
  let locationId: string;
  const ids: string[] = [];

  beforeAll(async () => {
    host = await createTestUser();
    booker = await createTestUser();
    await grantRole(host, "host");
    await grantRole(booker, "booker");
    locationId = await bookableLocation(host, "Ordering Location");

    // Created oldest-first, but with DESCENDING shoot dates, so `created_at DESC` and
    // `start_at DESC` give opposite answers and the test cannot pass by coincidence.
    const dates = ["2026-10-28", "2026-10-21", "2026-10-14", "2026-10-07"];
    for (const date of dates) {
      ids.push(await book(booker, locationId, date, 9));
      // created_at has microsecond resolution; a small gap keeps the order unambiguous.
      await new Promise((r) => setTimeout(r, 25));
    }
  });

  afterAll(async () => {
    await deleteTestUser(host.id);
    await deleteTestUser(booker.id);
  });

  it("returns the most recently created booking first", async () => {
    const res = await request(app).get("/v1/bookings").set(authHeader(booker)).query({ booker_id: booker.id, pageSize: 100 });
    expect(res.status).toBe(200);
    const returned = (res.body.data as { id: string }[]).map((b) => b.id);
    expect(returned).toEqual([...ids].reverse());
  });

  it("keeps the ordering global across pages — page 2 is never newer than page 1", async () => {
    const page1 = await request(app).get("/v1/bookings").set(authHeader(booker)).query({ booker_id: booker.id, page: 1, pageSize: 2 });
    const page2 = await request(app).get("/v1/bookings").set(authHeader(booker)).query({ booker_id: booker.id, page: 2, pageSize: 2 });
    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);

    const p1 = page1.body.data as { id: string; created_at: string }[];
    const p2 = page2.body.data as { id: string; created_at: string }[];
    expect(p1.map((b) => b.id)).toEqual([...ids].reverse().slice(0, 2));
    expect(p2.map((b) => b.id)).toEqual([...ids].reverse().slice(2, 4));

    const oldestOnPage1 = new Date(p1[p1.length - 1]!.created_at).getTime();
    const newestOnPage2 = new Date(p2[0]!.created_at).getTime();
    expect(oldestOnPage1).toBeGreaterThanOrEqual(newestOnPage2);
  });

  it("still offers the old shoot-date ordering behind sort=start_at_desc", async () => {
    const res = await request(app)
      .get("/v1/bookings")
      .set(authHeader(booker))
      .query({ booker_id: booker.id, pageSize: 100, sort: "start_at_desc" });
    expect(res.status).toBe(200);
    // The fixtures' shoot dates descend in creation order, so this is the creation order itself.
    expect((res.body.data as { id: string }[]).map((b) => b.id)).toEqual(ids);
  });
});

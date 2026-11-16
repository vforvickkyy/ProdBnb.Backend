import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Host payouts: bank details, earnings per booking, and payouts the team records.
 * Cashfree is faked; everything else runs against the local Supabase stack.
 */
const mock = vi.hoisted(() => ({
  orders: new Map<string, { amount: number; currency: string; settled: boolean }>(),
  putObject: vi.fn(async () => undefined),
}));

vi.mock("../src/modules/payments/providers/CashfreeProvider", () => ({
  CashfreeProvider: class {
    name = "cashfree" as const;
    async createOrder(input: { merchantOrderId: string; amountMinorUnits: number; currency: string; returnUrl?: string }) {
      mock.orders.set(input.merchantOrderId, { amount: input.amountMinorUnits, currency: input.currency, settled: false });
      return {
        providerReferenceId: `cf_${input.merchantOrderId}`,
        status: "pending" as const,
        checkout: { payment_session_id: `session_${input.merchantOrderId}`, order_id: input.merchantOrderId },
        raw: { mocked: true },
      };
    }
    async fetchOrder(orderId: string) {
      const order = mock.orders.get(orderId)!;
      // The order stays open; a successful attempt (paid by UPI) settles it -- the verify path.
      return {
        status: "pending" as const,
        settledAttempt: order.settled
          ? {
              id: `att_${orderId}`,
              status: "success",
              rawStatus: "SUCCESS",
              amountMinorUnits: order.amount,
              currency: order.currency,
              attemptedAt: null,
              completedAt: null,
              method: "upi",
              errorCode: null,
              errorDescription: null,
            }
          : null,
        lastAttempt: null,
        providerReferenceId: `cf_${orderId}`,
        checkout: { payment_session_id: `session_again_${orderId}`, order_id: orderId },
        amountMinorUnits: order.amount,
        currency: order.currency,
        raw: { mocked: true },
      };
    }
    async terminateOrder() {}
    async createRefund(input: { merchantRefundId: string }) {
      return { providerReferenceId: `cf_${input.merchantRefundId}`, status: "success" as const, raw: { mocked: true } };
    }
    verifyAndParseWebhook() {
      return null;
    }
  },
}));


import { createApp } from "../src/app";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

const app = createApp();
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.accessToken}` });

function mondayFromNow(weeks: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7 * weeks + ((8 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}

describe("host payouts", () => {
  let host: TestUser;
  let booker: TestUser;
  let finance: TestUser;
  let support: TestUser;
  let locationId: string;
  let slot = 0;

  async function grant(user: TestUser, role: "host" | "booker") {
    expect((await request(app).post("/v1/me/roles").set(auth(user)).send({ role })).status).toBe(201);
  }
  async function makeAdmin(user: TestUser, teamRole: "finance" | "support") {
    await adminClient.from("user_roles").insert({ user_id: user.id, role: "admin" });
    await adminClient.from("admin_team_members").update({ team_role: teamRole }).eq("user_id", user.id);
  }

  /** A paid booking (₹1,000 listing price + fee + tax) at the host's listing, then set to `status`. */
  async function paidBooking(opts: { when: "past" | "future"; status?: string; cancelledBy?: string }): Promise<{ id: string; paymentId: string; total: number }> {
    const day = opts.when === "past" ? "2026-10-05" : mondayFromNow(2);
    const hour = 8 + (slot++ % 10);
    const res = await request(app)
      .post("/v1/bookings")
      .set(auth(booker))
      .send({ location_id: locationId, start_at: `${day}T${String(hour).padStart(2, "0")}:00:00Z`, end_at: `${day}T${String(hour + 1).padStart(2, "0")}:00:00Z` });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.data.id as string;
    const pay = await request(app).post(`/v1/bookings/${id}/payment`).set(auth(booker)).send({ customer_phone: "9876543210" });
    mock.orders.get(pay.body.data.checkout.order_id)!.settled = true;
    expect((await request(app).post(`/v1/payments/${pay.body.data.payment_id}/verify`).set(auth(booker))).body.data.status).toBe("success");
    if (opts.status) {
      await adminClient
        .from("bookings")
        .update({ status: opts.status, ...(opts.cancelledBy ? { cancelled_by: opts.cancelledBy, cancelled_at: new Date().toISOString() } : {}) })
        .eq("id", id);
    }
    return { id, paymentId: pay.body.data.payment_id, total: res.body.data.pricing.total_amount_minor_units };
  }

  beforeAll(async () => {
    [host, booker, finance, support] = await Promise.all([createTestUser(), createTestUser(), createTestUser(), createTestUser()]);
    await grant(host, "host");
    await grant(booker, "booker");
    await makeAdmin(finance, "finance");
    await makeAdmin(support, "support");
    const loc = await request(app).post("/v1/locations").set(auth(host)).send({ title: "Payout test loft", city: "Mumbai", country: "India", timezone: "UTC" });
    locationId = loc.body.data.id;
    await request(app).post(`/v1/locations/${locationId}/availability/rules`).set(auth(host)).send({ day_of_week: "monday", start_time: "06:00", end_time: "22:00" });
    await request(app).post(`/v1/locations/${locationId}/pricing`).set(auth(host)).send({ booking_type: "hourly", amount_minor_units: 100000 });
    await adminClient.from("locations").update({ status: "published" }).eq("id", locationId);
  });

  afterAll(async () => {
    for (const u of [host, booker, finance, support]) await deleteTestUser(u.id).catch(() => undefined);
  });

  it("stores bank details encrypted and only ever returns them masked to the host", async () => {
    expect((await request(app).get("/v1/me/payout-account").set(auth(host))).body.data).toBeNull();
    const bad = await request(app)
      .put("/v1/me/payout-account")
      .set(auth(host))
      .send({ account_holder_name: "Aanya Kapoor", account_number: "12345678901", ifsc: "HDFC123", pan: "ABCDE1234F" });
    expect(bad.status).toBe(400);
    expect((await request(app).put("/v1/me/payout-account").set(auth(booker)).send({})).status).toBe(403);

    const saved = await request(app)
      .put("/v1/me/payout-account")
      .set(auth(host))
      .send({ account_holder_name: "Aanya Kapoor", account_number: "1234 5678 9012", ifsc: "hdfc0001234", bank_name: "HDFC Bank", pan: "abcde1234f" });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data).toMatchObject({ account_holder_name: "Aanya Kapoor", account_last4: "9012", ifsc: "HDFC0001234", pan_last4: "1234F" });
    expect(JSON.stringify(saved.body)).not.toContain("123456789012");
    expect(JSON.stringify(saved.body)).not.toContain("ABCDE1234F");

    const { data: row } = await adminClient.from("host_payout_accounts").select("*").eq("user_id", host.id).single();
    expect(JSON.stringify(row)).not.toContain("123456789012");
  });

  it("works out what the host earns per booking, and when it is payable", async () => {
    const upcoming = await paidBooking({ when: "future", status: "confirmed" });
    const ready = await paidBooking({ when: "past", status: "completed" });
    const declined = await paidBooking({ when: "past", status: "cancelled", cancelledBy: host.id });
    const held = await paidBooking({ when: "past", status: "completed" });
    await request(app).post(`/v1/bookings/${held.id}/refund-requests`).set(auth(booker)).send({ reason: "The lights failed." });
    const partly = await paidBooking({ when: "past", status: "completed" });
    // Refund 40% of what the booker paid: the host's share falls by 40% too.
    const refund = await request(app).post(`/v1/admin/payments/${partly.paymentId}/refunds`).set(auth(finance)).send({ amount_minor_units: Math.round(partly.total * 0.4) });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);

    const res = await request(app).get("/v1/me/earnings").set(auth(host));
    expect(res.status).toBe(200);
    const by = new Map(res.body.data.rows.map((r: { booking_id: string }) => [r.booking_id, r]));
    expect(by.get(upcoming.id)).toMatchObject({ state: "upcoming", net_minor_units: 100000, listing_price_minor_units: 100000 });
    expect(by.get(ready.id)).toMatchObject({ state: "ready", net_minor_units: 100000, refunded_minor_units: 0 });
    expect(by.get(declined.id)).toMatchObject({ state: "not_payable", net_minor_units: 0 });
    expect(by.get(held.id)).toMatchObject({ state: "on_hold", net_minor_units: 100000 });
    expect(by.get(partly.id)).toMatchObject({ state: "ready", net_minor_units: 60000 });
    expect(res.body.data.summary).toMatchObject({ upcoming_minor_units: 100000, ready_minor_units: 160000, on_hold_minor_units: 100000, paid_minor_units: 0 });

    // The booker sees none of this.
    expect((await request(app).get("/v1/me/earnings").set(auth(booker))).body.data.rows).toEqual([]);
  });

  it("lets finance see who is owed, reveal bank details (audited) and record a payout once", async () => {
    const due = await request(app).get("/v1/admin/payouts/due").set(auth(support));
    expect(due.status).toBe(200);
    const mine = due.body.data.find((d: { host: { id: string } }) => d.host.id === host.id);
    expect(mine).toMatchObject({ ready_minor_units: 160000, ready_bookings: 2, on_hold_minor_units: 100000, account: { account_last4: "9012" } });

    expect((await request(app).post(`/v1/admin/hosts/${host.id}/payout-account/reveal`).set(auth(support)).send({})).status).toBe(403);
    const revealed = await request(app).post(`/v1/admin/hosts/${host.id}/payout-account/reveal`).set(auth(finance)).send({ reason: "November payout" });
    expect(revealed.status).toBe(200);
    expect(revealed.body.data).toMatchObject({ account_number: "123456789012", pan: "ABCDE1234F", ifsc: "HDFC0001234" });

    const earnings = await request(app).get(`/v1/admin/hosts/${host.id}/earnings`).set(auth(finance));
    const readyIds = earnings.body.data.rows.filter((r: { state: string }) => r.state === "ready").map((r: { booking_id: string }) => r.booking_id);
    const upcomingId = earnings.body.data.rows.find((r: { state: string }) => r.state === "upcoming").booking_id;

    expect((await request(app).post(`/v1/admin/hosts/${host.id}/payouts`).set(auth(finance)).send({ booking_ids: [upcomingId], reference: "UTR1" })).status).toBe(400);
    expect((await request(app).post(`/v1/admin/hosts/${host.id}/payouts`).set(auth(support)).send({ booking_ids: readyIds, reference: "UTR1" })).status).toBe(403);

    const paid = await request(app)
      .post(`/v1/admin/hosts/${host.id}/payouts`)
      .set(auth(finance))
      .send({ booking_ids: readyIds, reference: "UTR20261117001", note: "November" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.data).toMatchObject({ amount_minor_units: 160000, booking_count: 2, account_last4: "9012", reference: "UTR20261117001" });

    // Nothing can be paid twice.
    expect((await request(app).post(`/v1/admin/hosts/${host.id}/payouts`).set(auth(finance)).send({ booking_ids: readyIds, reference: "UTR2" })).status).toBe(400);

    const hostView = await request(app).get("/v1/me/payouts").set(auth(host));
    expect(hostView.body.data).toHaveLength(1);
    const after = await request(app).get("/v1/me/earnings").set(auth(host));
    expect(after.body.data.summary).toMatchObject({ ready_minor_units: 0, paid_minor_units: 160000 });
    expect(after.body.data.rows.find((r: { booking_id: string }) => r.booking_id === readyIds[0]).payout).toMatchObject({ reference: "UTR20261117001" });

    const { data: audit } = await adminClient.from("admin_audit_log").select("action").eq("admin_id", finance.id);
    expect((audit ?? []).map((a) => a.action)).toEqual(expect.arrayContaining(["ADMIN_VIEWED_PAYOUT_DETAILS", "ADMIN_RECORDED_PAYOUT"]));
  });

  it("refuses a payout to a host without bank details, and removes details on request", async () => {
    expect((await request(app).delete("/v1/me/payout-account").set(auth(host))).body.data).toEqual({ removed: true });
    const ready = await paidBooking({ when: "past", status: "completed" });
    const res = await request(app).post(`/v1/admin/hosts/${host.id}/payouts`).set(auth(finance)).send({ booking_ids: [ready.id], reference: "UTR3" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/payout details/);
  });
});

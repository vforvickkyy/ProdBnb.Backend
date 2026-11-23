import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Booker account: refund requests, payment history, account deletion, profile photo.
 * Cashfree and R2 are faked; everything else runs against the local Supabase stack.
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

vi.mock("../src/lib/r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/r2")>();
  return { ...actual, putObject: mock.putObject };
});

import { createApp } from "../src/app";
import { clearSiteConfigCache } from "../src/modules/site/integrations.service";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

const app = createApp();
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.accessToken}` });

/** A Monday at least a week ahead, so bookings on it are "upcoming". */
function nextMonday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7 + ((8 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}
const PAST_MONDAY = "2026-10-05";
const FUTURE_MONDAY = nextMonday();

describe("booker account", () => {
  let host: TestUser;
  let booker: TestUser;
  let stranger: TestUser;
  let finance: TestUser;
  let support: TestUser;
  let locationId: string;
  let hour = 9;

  async function grant(user: TestUser, role: "host" | "booker") {
    expect((await request(app).post("/v1/me/roles").set(auth(user)).send({ role })).status).toBe(201);
  }
  async function makeAdmin(user: TestUser, teamRole: "finance" | "support") {
    const { error } = await adminClient.from("user_roles").insert({ user_id: user.id, role: "admin" });
    if (error) throw error;
    const { error: e2 } = await adminClient.from("admin_team_members").update({ team_role: teamRole }).eq("user_id", user.id);
    if (e2) throw e2;
  }

  /** A new booking at the shared location, a fresh hour each time so slots never collide. */
  async function book(who: TestUser, day = PAST_MONDAY): Promise<string> {
    const start = `${day}T${String(hour).padStart(2, "0")}:00:00Z`;
    const end = `${day}T${String(hour + 1).padStart(2, "0")}:00:00Z`;
    hour = hour >= 16 ? 9 : hour + 1;
    const res = await request(app).post("/v1/bookings").set(auth(who)).send({ location_id: locationId, start_at: start, end_at: end });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data.id as string;
  }

  /** Pays for a booking (UPI) and reconciles, as the website does after checkout. */
  async function pay(who: TestUser, bookingId: string): Promise<string> {
    const res = await request(app).post(`/v1/bookings/${bookingId}/payment`).set(auth(who)).send({ customer_phone: "9876543210" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    mock.orders.get(res.body.data.checkout.order_id)!.settled = true;
    const verified = await request(app).post(`/v1/payments/${res.body.data.payment_id}/verify`).set(auth(who));
    expect(verified.body.data.status).toBe("success");
    return res.body.data.payment_id as string;
  }

  beforeAll(async () => {
    [host, booker, stranger, finance, support] = await Promise.all([createTestUser(), createTestUser(), createTestUser(), createTestUser(), createTestUser()]);
    await grant(host, "host");
    await grant(booker, "booker");
    await grant(stranger, "booker");
    await makeAdmin(finance, "finance");
    await makeAdmin(support, "support");
    const loc = await request(app).post("/v1/locations").set(auth(host)).send({ title: "Account test studio", city: "Pune", country: "India", timezone: "UTC" });
    expect(loc.status).toBe(201);
    locationId = loc.body.data.id;
    for (const day of ["monday"]) {
      await request(app).post(`/v1/locations/${locationId}/availability/rules`).set(auth(host)).send({ day_of_week: day, start_time: "08:00", end_time: "20:00" });
    }
    await request(app).post(`/v1/locations/${locationId}/pricing`).set(auth(host)).send({ booking_type: "hourly", amount_minor_units: 150000 });
    await adminClient.from("locations").update({ status: "published" }).eq("id", locationId);
  });

  afterAll(async () => {
    for (const u of [host, booker, stranger, finance, support]) await deleteTestUser(u.id).catch(() => undefined);
  });

  it("records the method a payment settled with and lists the booker's own payments", async () => {
    const bookingId = await book(booker);
    const paymentId = await pay(booker, bookingId);

    const mine = await request(app).get("/v1/me/payments").set(auth(booker));
    expect(mine.status).toBe(200);
    const row = mine.body.data.find((p: { id: string }) => p.id === paymentId);
    expect(row).toMatchObject({ status: "success", method: "upi", refunded_minor_units: 0, booking: { id: bookingId, location: { title: "Account test studio" } } });
    expect(row.booking).not.toHaveProperty("booker_id");
    expect(mine.body.meta.total).toBeGreaterThanOrEqual(1);

    // Someone else's history never includes it -- not even the host, who can see the payment itself.
    for (const other of [stranger, host]) {
      const theirs = await request(app).get("/v1/me/payments").set(auth(other));
      expect(theirs.body.data.map((p: { id: string }) => p.id)).not.toContain(paymentId);
    }
  });

  it("opens a refund request when a paid booking is cancelled, and nothing for an unpaid one", async () => {
    const unpaid = await book(booker);
    expect((await request(app).post(`/v1/bookings/${unpaid}/cancel`).set(auth(booker)).send({ reason: "Changed plans" })).status).toBe(200);

    const paid = await book(booker);
    await pay(booker, paid);
    expect((await request(app).post(`/v1/bookings/${paid}/cancel`).set(auth(booker)).send({ reason: "Shoot postponed" })).status).toBe(200);

    const requests = await request(app).get("/v1/me/refund-requests").set(auth(booker));
    expect(requests.status).toBe(200);
    expect(requests.body.data.some((r: { booking_id: string }) => r.booking_id === unpaid)).toBe(false);
    const opened = requests.body.data.find((r: { booking_id: string }) => r.booking_id === paid);
    expect(opened).toMatchObject({ status: "pending", source: "cancellation", reason: "Shoot postponed" });

    const { data: notes } = await adminClient.from("notifications").select("type, entity_id").eq("user_id", booker.id).eq("type", "booking_updated");
    expect((notes ?? []).some((n) => n.entity_id === paid)).toBe(true);

    // Another booker can't see or withdraw it.
    expect((await request(app).get(`/v1/me/refund-requests?booking_id=${paid}`).set(auth(stranger))).body.data).toEqual([]);
    expect((await request(app).post(`/refund-requests/${opened.id}/withdraw`).set(auth(stranger))).status).toBe(404);
    expect((await request(app).post(`/v1/refund-requests/${opened.id}/withdraw`).set(auth(stranger))).status).toBe(404);
  });

  it("lets a booker ask for a refund on a paid booking, once at a time, and withdraw it", async () => {
    const bookingId = await book(booker);
    await pay(booker, bookingId);
    await adminClient.from("bookings").update({ status: "completed" }).eq("id", bookingId);

    const first = await request(app).post(`/v1/bookings/${bookingId}/refund-requests`).set(auth(booker)).send({ reason: "The AC didn't work." });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ status: "pending", source: "booker" });
    expect((await request(app).post(`/v1/bookings/${bookingId}/refund-requests`).set(auth(booker)).send({ reason: "Again" })).status).toBe(409);
    expect((await request(app).post(`/v1/bookings/${bookingId}/refund-requests`).set(auth(stranger)).send({ reason: "Mine?" })).status).toBe(404);
    expect((await request(app).post(`/v1/bookings/${bookingId}/refund-requests`).set(auth(booker)).send({})).status).toBe(400);

    const withdrawn = await request(app).post(`/v1/refund-requests/${first.body.data.id}/withdraw`).set(auth(booker));
    expect(withdrawn.body.data.status).toBe("withdrawn");
    expect((await request(app).post(`/v1/refund-requests/${first.body.data.id}/withdraw`).set(auth(booker))).status).toBe(400);
    expect((await request(app).post(`/v1/bookings/${bookingId}/refund-requests`).set(auth(booker)).send({ reason: "Asking again." })).status).toBe(201);

    const unpaid = await book(booker);
    await adminClient.from("bookings").update({ status: "confirmed" }).eq("id", unpaid);
    expect((await request(app).post(`/v1/bookings/${unpaid}/refund-requests`).set(auth(booker)).send({ reason: "?" })).status).toBe(400);
  });

  it("lets finance approve part of a refund through the normal refund path, and decline with a note", async () => {
    const a = await book(booker);
    const paymentA = await pay(booker, a);
    await request(app).post(`/v1/bookings/${a}/cancel`).set(auth(booker)).send({});
    const b = await book(booker);
    await pay(booker, b);
    await request(app).post(`/v1/bookings/${b}/cancel`).set(auth(host)).send({ reason: "Venue flooded" });

    // Pending requests are listed oldest first, and earlier runs can leave some behind locally:
    // read every page rather than assume ours are on the first.
    const pending: { booking_id: string }[] = [];
    for (let page = 1; page <= 50; page += 1) {
      const list = await request(app).get(`/v1/admin/refund-requests?status=pending&pageSize=100&page=${page}`).set(auth(finance));
      expect(list.status).toBe(200);
      pending.push(...list.body.data);
      if (pending.length >= list.body.meta.total || list.body.data.length === 0) break;
    }
    const reqA = pending.find((r) => r.booking_id === a);
    const reqB = pending.find((r) => r.booking_id === b);
    expect(reqA).toMatchObject({ remaining_minor_units: 150000, payment: { method: "upi" }, booking: { location: { title: "Account test studio" } } });
    // The host cancelled B: the booker didn't open it themselves.
    expect(reqB).toMatchObject({ source: "cancellation", reason: "Venue flooded" });

    // Support can look but not decide.
    expect((await request(app).get("/v1/admin/refund-requests").set(auth(support))).status).toBe(200);
    expect((await request(app).post(`/v1/admin/refund-requests/${reqA.id}/approve`).set(auth(support)).send({})).status).toBe(403);

    const approved = await request(app).post(`/v1/admin/refund-requests/${reqA.id}/approve`).set(auth(finance)).send({ amount_minor_units: 75000, note: "50% under policy" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({ status: "approved", approved_amount_minor_units: 75000, decision_note: "50% under policy" });
    expect((await request(app).post(`/v1/admin/refund-requests/${reqA.id}/approve`).set(auth(finance)).send({})).status).toBe(409);

    const payment = await request(app).get(`/v1/payments/${paymentA}`).set(auth(booker));
    expect(payment.body.data.status).toBe("partially_refunded");
    const mine = await request(app).get("/v1/me/payments").set(auth(booker));
    expect(mine.body.data.find((p: { id: string }) => p.id === paymentA).refunded_minor_units).toBe(75000);

    expect((await request(app).post(`/v1/admin/refund-requests/${reqB.id}/decline`).set(auth(finance)).send({})).status).toBe(400);
    const declined = await request(app).post(`/v1/admin/refund-requests/${reqB.id}/decline`).set(auth(finance)).send({ note: "Rebooked for next week instead." });
    expect(declined.body.data).toMatchObject({ status: "declined", decision_note: "Rebooked for next week instead." });

    const { data: audit } = await adminClient.from("admin_audit_log").select("action").eq("admin_id", finance.id);
    expect((audit ?? []).map((x) => x.action)).toEqual(expect.arrayContaining(["ADMIN_APPROVED_REFUND_REQUEST", "ADMIN_CREATED_REFUND", "ADMIN_DECLINED_REFUND_REQUEST"]));
    const { data: notes } = await adminClient.from("notifications").select("title").eq("user_id", booker.id).eq("type", "booking_updated");
    expect((notes ?? []).map((n) => n.title)).toEqual(expect.arrayContaining(["Refund approved", "Refund request reviewed"]));
  });

  it("only lets a checkout return to this site", async () => {
    const bookingId = await book(booker);
    const evil = await request(app)
      .post(`/v1/bookings/${bookingId}/payment`)
      .set(auth(booker))
      .send({ customer_phone: "9876543210", return_url: "https://evil.example.com/thanks" });
    expect(evil.status).toBe(400);
    await adminClient.from("site_settings").update({ primary_domain: "shoots.example.in" }).eq("singleton", true);
    clearSiteConfigCache();
    try {
      const ok = await request(app)
        .post(`/v1/bookings/${bookingId}/payment`)
        .set(auth(booker))
        .send({ customer_phone: "9876543210", return_url: `https://shoots.example.in/account/bookings/${bookingId}?paid=1` });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      const config = await request(app).get("/v1/site-config");
      expect(config.body.data.payments).toEqual({ provider: "cashfree", mode: "sandbox" });
    } finally {
      await adminClient.from("site_settings").update({ primary_domain: null }).eq("singleton", true);
      clearSiteConfigCache();
    }
  });

  it("stores a real image as the profile photo and refuses anything else", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    const res = await request(app).post("/v1/me/avatar").set(auth(booker)).set("Content-Type", "image/png").send(png);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.avatar_url).toMatch(new RegExp(`/avatars/${booker.id}/[0-9a-f-]+\\.png$`));
    expect(mock.putObject).toHaveBeenCalledWith(expect.stringMatching(`^avatars/${booker.id}/`), expect.any(Buffer), "image/png");
    const me = await request(app).get("/v1/me").set(auth(booker));
    expect(me.body.data.profile.avatar_url).toBe(res.body.data.avatar_url);

    const fake = await request(app).post("/v1/me/avatar").set(auth(booker)).set("Content-Type", "image/jpeg").send(Buffer.from("not an image at all"));
    expect(fake.status).toBe(400);
    const gif = await request(app).post("/v1/me/avatar").set(auth(booker)).set("Content-Type", "image/gif").send(Buffer.from("GIF89a"));
    expect(gif.status).toBe(400);
    const huge = await request(app).post("/v1/me/avatar").set(auth(booker)).set("Content-Type", "image/png").send(Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]));
    expect(huge.status).toBe(413);
  });

  it("handles an account deletion request end to end", async () => {
    const leaver = await createTestUser();
    await grant(leaver, "booker");
    const upcoming = await book(leaver, FUTURE_MONDAY);

    const status = await request(app).get("/v1/me/deletion-request").set(auth(leaver));
    expect(status.body.data).toEqual({ request: null, blockers: { upcoming_bookings: 1, upcoming_hosted_bookings: 0 } });
    const blocked = await request(app).post("/v1/me/deletion-request").set(auth(leaver)).send({ reason: "Done shooting" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/1 upcoming booking/);

    await request(app).post(`/v1/bookings/${upcoming}/cancel`).set(auth(leaver)).send({});
    const asked = await request(app).post("/v1/me/deletion-request").set(auth(leaver)).send({ reason: "Done shooting" });
    expect(asked.status).toBe(201);
    expect((await request(app).post("/v1/me/deletion-request").set(auth(leaver)).send({})).status).toBe(409);
    expect((await request(app).delete("/v1/me/deletion-request").set(auth(leaver))).body.data.status).toBe("withdrawn");
    const again = await request(app).post("/v1/me/deletion-request").set(auth(leaver)).send({});
    expect(again.status).toBe(201);

    // Moderators (users.manage) complete it; support can only look.
    const moderator = await createTestUser();
    await adminClient.from("user_roles").insert({ user_id: moderator.id, role: "admin" });
    await adminClient.from("admin_team_members").update({ team_role: "moderator" }).eq("user_id", moderator.id);
    const list = await request(app).get("/v1/admin/deletion-requests?status=pending").set(auth(support));
    const row = list.body.data.find((r: { id: string }) => r.id === again.body.data.id);
    expect(row).toMatchObject({ email: leaver.email, blockers: { upcoming_bookings: 0 } });
    expect((await request(app).post(`/v1/admin/deletion-requests/${row.id}/complete`).set(auth(support)).send({})).status).toBe(403);

    const done = await request(app).post(`/v1/admin/deletion-requests/${row.id}/complete`).set(auth(moderator)).send({ note: "Verified by email" });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data.status).toBe("completed");

    const { data: profile } = await adminClient.from("profiles").select("first_name, last_name, phone, status").eq("id", leaver.id).single();
    expect(profile).toEqual({ first_name: "Deleted", last_name: "user", phone: null, status: "deleted" });
    const { data: authUser } = await adminClient.auth.admin.getUserById(leaver.id);
    expect(authUser.user?.email).toBe(`deleted+${leaver.id}@deleted.invalid`);
    // Their bookings are kept for the records; their old session no longer works.
    expect((await adminClient.from("bookings").select("id").eq("id", upcoming)).data).toHaveLength(1);
    expect((await request(app).get("/v1/me").set(auth(leaver))).status).not.toBe(200);
    const { data: audit } = await adminClient.from("admin_audit_log").select("action, target_type").eq("admin_id", moderator.id);
    expect(audit).toEqual([{ action: "ADMIN_COMPLETED_ACCOUNT_DELETION", target_type: "deletion_request" }]);

    await deleteTestUser(moderator.id);
    await deleteTestUser(leaver.id).catch(() => undefined);
  });

  it("keeps a booker's bookings readable after the listing is archived", async () => {
    const bookingId = await book(booker);
    await adminClient.from("locations").update({ status: "archived" }).eq("id", locationId);
    try {
      const list = await request(app).get("/v1/bookings").query({ booker_id: booker.id, pageSize: 100 }).set(auth(booker));
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      const row = list.body.data.find((b: { id: string }) => b.id === bookingId);
      expect(row.location).toMatchObject({ id: locationId, title: "Account test studio", city: "Pune", timezone: "UTC", host: null, primary_media_url: null });
      const one = await request(app).get(`/v1/bookings/${bookingId}`).set(auth(booker));
      expect(one.status).toBe(200);
      expect(one.body.data.location.title).toBe("Account test studio");
    } finally {
      await adminClient.from("locations").update({ status: "published" }).eq("id", locationId);
    }
  });

  it("refuses deletion while someone has an upcoming booking at the person's listing", async () => {
    const guest = await book(stranger, FUTURE_MONDAY);
    const res = await request(app).post("/v1/me/deletion-request").set(auth(host)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/at your listings/);
    await request(app).post(`/v1/bookings/${guest}/cancel`).set(auth(stranger)).send({});
  });
});

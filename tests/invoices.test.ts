import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Invoices and receipts: one tax invoice per paid booking, issued when the payment settles (once the
 * template has a company name and address), emailed automatically when email works, otherwise left
 * "pending" for the team to send. Cashfree and SMTP are faked; everything else is the local stack.
 */
const mock = vi.hoisted(() => ({
  orders: new Map<string, { amount: number; currency: string; settled: boolean }>(),
  smtp: { connected: true, fail: false },
  sent: [] as { to: string; subject: string; attachments?: { filename: string; content: Buffer }[] }[],
}));

vi.mock("../src/modules/payments/providers/CashfreeProvider", () => ({
  CashfreeProvider: class {
    name = "cashfree" as const;
    async createOrder(input: { merchantOrderId: string; amountMinorUnits: number; currency: string }) {
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
      return {
        status: "pending" as const,
        settledAttempt: order.settled
          ? { id: `att_${orderId}`, status: "success", rawStatus: "SUCCESS", amountMinorUnits: order.amount, currency: order.currency, attemptedAt: null, completedAt: null, method: "upi", errorCode: null, errorDescription: null }
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

vi.mock("../src/modules/outreach/channels.service", async (original) => ({
  ...(await original<typeof import("../src/modules/outreach/channels.service")>()),
  smtpCredentials: async () => (mock.smtp.connected ? { config: { from_name: "Team", from_email: "team@example.com" }, password: "x", version: "1" } : null),
}));
vi.mock("../src/modules/outreach/email", async (original) => ({
  ...(await original<typeof import("../src/modules/outreach/email")>()),
  sendEmail: async (message: { to: string; subject: string; attachments?: { filename: string; content: Buffer }[] }) => {
    if (mock.smtp.fail) throw new Error("Mailbox unavailable");
    mock.sent.push(message);
    return "msg-1";
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

const COMPANY = {
  legal_name: "Test Locations Pvt Ltd",
  trade_name: "TestCo",
  gstin: "27AABCT1234F1Z5",
  address_line1: "12 Film City Road",
  city: "Mumbai",
  state: "Maharashtra",
  state_code: "27",
  postal_code: "400065",
  sac_code: "997212",
};

describe("invoices and receipts", () => {
  let host: TestUser;
  let booker: TestUser;
  let finance: TestUser;
  let support: TestUser;
  let locationId: string;
  let slot = 0;
  let originalSettings: Record<string, unknown>;

  async function grant(user: TestUser, role: "host" | "booker") {
    expect((await request(app).post("/v1/me/roles").set(auth(user)).send({ role })).status).toBe(201);
  }
  async function makeAdmin(user: TestUser, teamRole: "finance" | "support") {
    await adminClient.from("user_roles").insert({ user_id: user.id, role: "admin" });
    await adminClient.from("admin_team_members").update({ team_role: teamRole }).eq("user_id", user.id);
  }
  async function paidBooking(): Promise<{ id: string; paymentId: string; total: number }> {
    const day = mondayFromNow(3 + Math.floor(slot / 7));
    const hour = 8 + 2 * (slot++ % 7);
    const res = await request(app)
      .post("/v1/bookings")
      .set(auth(booker))
      .send({ location_id: locationId, start_at: `${day}T${String(hour).padStart(2, "0")}:00:00Z`, end_at: `${day}T${String(hour + 1).padStart(2, "0")}:00:00Z` });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.data.id as string;
    const pay = await request(app).post(`/v1/bookings/${id}/payment`).set(auth(booker)).send({ customer_phone: "9876543210" });
    mock.orders.get(pay.body.data.checkout.order_id)!.settled = true;
    expect((await request(app).post(`/v1/payments/${pay.body.data.payment_id}/verify`).set(auth(booker))).body.data.status).toBe("success");
    return { id, paymentId: pay.body.data.payment_id, total: res.body.data.pricing.total_amount_minor_units };
  }
  const invoiceFor = async (bookingId: string) => (await adminClient.from("invoices").select("*").eq("booking_id", bookingId).maybeSingle()).data;

  beforeAll(async () => {
    const { data } = await adminClient.from("invoice_settings").select("*").eq("singleton", true).single();
    originalSettings = data as Record<string, unknown>;
    await adminClient.from("invoice_settings").update({ legal_name: null, address_line1: null, city: null, state: null, postal_code: null, auto_send: true }).eq("singleton", true);

    [host, booker, finance, support] = await Promise.all([createTestUser(), createTestUser(), createTestUser(), createTestUser()]);
    await grant(host, "host");
    await grant(booker, "booker");
    await makeAdmin(finance, "finance");
    await makeAdmin(support, "support");
    await adminClient.from("profiles").update({ first_name: "Riya", last_name: "Menon", address_region: "Karnataka" }).eq("id", booker.id);
    const loc = await request(app).post("/v1/locations").set(auth(host)).send({ title: "Invoice test studio", city: "Mumbai", country: "India", timezone: "UTC" });
    locationId = loc.body.data.id;
    await request(app).post(`/v1/locations/${locationId}/availability/rules`).set(auth(host)).send({ day_of_week: "monday", start_time: "06:00", end_time: "23:00" });
    await request(app).post(`/v1/locations/${locationId}/pricing`).set(auth(host)).send({ booking_type: "hourly", amount_minor_units: 100000 });
    await adminClient.from("locations").update({ status: "published" }).eq("id", locationId);
  });

  beforeEach(() => {
    mock.smtp.connected = true;
    mock.smtp.fail = false;
    mock.sent.length = 0;
  });

  afterAll(async () => {
    const { id: _id, singleton: _s, updated_at: _u, ...rest } = originalSettings;
    await adminClient.from("invoice_settings").update(rest).eq("singleton", true);
    for (const u of [host, booker, finance, support]) await deleteTestUser(u.id).catch(() => undefined);
  });

  it("waits for the template, then issues missing invoices in one go", async () => {
    const early = await paidBooking();
    expect(await invoiceFor(early.id)).toBeNull();

    const settings = await request(app).get("/v1/admin/invoice-settings").set(auth(finance));
    expect(settings.status).toBe(200);
    expect(settings.body.data.missing).toEqual(["legal name", "address"]);

    expect((await request(app).post("/v1/admin/invoices/issue-missing").set(auth(finance))).status).toBe(400);
    expect((await request(app).patch("/v1/admin/invoice-settings").set(auth(support)).send(COMPANY)).status).toBe(403);
    expect((await request(app).patch("/v1/admin/invoice-settings").set(auth(finance)).send({ gstin: "nope" })).status).toBe(400);
    const saved = await request(app).patch("/v1/admin/invoice-settings").set(auth(finance)).send(COMPANY);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data.missing).toEqual([]);

    const listed = await request(app).get("/v1/admin/invoices").set(auth(finance));
    expect(listed.body.meta.counts.waiting).toBeGreaterThanOrEqual(1);

    const issued = await request(app).post("/v1/admin/invoices/issue-missing").set(auth(finance));
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body.data.issued).toBeGreaterThanOrEqual(1);
    // Backfilled invoices wait to be sent, so old bookers aren't all emailed at once.
    const inv = await invoiceFor(early.id);
    expect(inv).toMatchObject({ delivery_status: "pending", sent_via: null, total_minor_units: early.total });
    expect(inv!.number).toMatch(/^INV\/\d{2}-\d{2}\/\d{4}$/);
    // (Booking and payment emails may go out; no invoice email does.)
    expect(mock.sent.filter((m) => m.subject.startsWith("Invoice "))).toHaveLength(0);
    const send = await request(app).post(`/v1/admin/invoices/${inv!.id}/send`).set(auth(finance)).send({});
    expect(send.body.data).toMatchObject({ delivery_status: "sent", sent_via: "manual", sent_to: booker.email });
    expect(mock.sent.some((m) => m.subject.includes(inv!.number) && m.attachments?.[0].filename.endsWith(".pdf"))).toBe(true);
  });

  it("issues and emails the invoice when a booking is paid, with a running number", async () => {
    const a = await paidBooking();
    const b = await paidBooking();
    const [ia, ib] = [await invoiceFor(a.id), await invoiceFor(b.id)];
    expect(ia).toMatchObject({ delivery_status: "sent", sent_via: "auto", user_id: booker.id, subtotal_minor_units: 100000 });
    expect(ib!.sequence).toBe(ia!.sequence + 1);
    expect(ia!.seller).toMatchObject({ name: "TestCo", gstin: "27AABCT1234F1Z5", state: "Maharashtra" });
    expect(ia!.billed_to).toMatchObject({ name: "Riya Menon", email: booker.email, state: "Karnataka" });
    expect(mock.sent.filter((m) => m.to === booker.email && m.subject.startsWith("Invoice "))).toHaveLength(2);

    // Verifying again doesn't issue or send a second one.
    await request(app).post(`/v1/payments/${a.paymentId}/verify`).set(auth(booker));
    expect((await adminClient.from("invoices").select("id").eq("booking_id", a.id)).data).toHaveLength(1);
  });

  it("leaves invoices pending when email isn't connected, and the team sends them by hand", async () => {
    mock.smtp.connected = false;
    const p = await paidBooking();
    const inv = await invoiceFor(p.id);
    expect(inv).toMatchObject({ delivery_status: "pending", sent_via: null });
    const pending = await request(app).get("/v1/admin/invoices").query({ filter: "pending" }).set(auth(finance));
    expect(pending.body.data.map((i: { id: string }) => i.id)).toContain(inv!.id);

    const noEmail = await request(app).post(`/v1/admin/invoices/${inv!.id}/send`).set(auth(finance)).send({});
    expect(noEmail.status).toBe(400);
    expect(noEmail.body.error.message).toMatch(/Email isn't connected/);

    mock.smtp.connected = true;
    expect((await request(app).post(`/v1/admin/invoices/${inv!.id}/send`).set(auth(support)).send({})).status).toBe(403);
    const sent = await request(app).post(`/v1/admin/invoices/${inv!.id}/send`).set(auth(finance)).send({ to: "accounts@lantern.example" });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.data).toMatchObject({ delivery_status: "sent", sent_via: "manual", sent_to: "accounts@lantern.example", send_count: 1 });

    const manual = await request(app).get("/v1/admin/invoices").query({ filter: "sent_manual" }).set(auth(finance));
    expect(manual.body.data.map((i: { id: string }) => i.id)).toContain(inv!.id);
    const detail = await request(app).get(`/v1/admin/invoices/${inv!.id}`).set(auth(support));
    expect(detail.body.data.events.map((e: { kind: string }) => e.kind)).toEqual(["sent_manual", "issued"]);
    const { data: audit } = await adminClient.from("admin_audit_log").select("action").eq("target_id", inv!.id);
    expect(audit!.map((a) => a.action)).toContain("ADMIN_SENT_INVOICE");
  });

  it("marks a failed send and retries it from the pending list", async () => {
    mock.smtp.fail = true;
    const p = await paidBooking();
    const inv = await invoiceFor(p.id);
    expect(inv).toMatchObject({ delivery_status: "failed", last_error: "Mailbox unavailable" });
    mock.smtp.fail = false;
    const res = await request(app).post("/v1/admin/invoices/send-pending").set(auth(finance));
    expect(res.status).toBe(200);
    expect(res.body.data.sent).toBeGreaterThanOrEqual(1);
    expect(await invoiceFor(p.id)).toMatchObject({ delivery_status: "sent", sent_via: "manual", last_error: null });
  });

  it("gives the booker their own invoices as PDFs, and nobody else's", async () => {
    const mine = await request(app).get("/v1/me/invoices").set(auth(booker));
    expect(mine.status).toBe(200);
    expect(mine.body.data.length).toBeGreaterThanOrEqual(3);
    const id = mine.body.data[0].id;
    const pdf = await request(app).get(`/v1/me/invoices/${id}/pdf`).set(auth(booker)).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await request(app).get(`/v1/me/invoices/${id}/pdf`).set(auth(host))).status).toBe(404);
    expect((await request(app).get("/v1/me/invoices").set(auth(host))).body.data).toEqual([]);
  });

  it("previews the template and lists, downloads and sends receipts", async () => {
    const preview = await request(app).post("/v1/admin/invoice-settings/preview").set(auth(support)).send({ trade_name: "Draft name", number_prefix: "PB" });
    expect(preview.status).toBe(200);
    expect(preview.headers["content-type"]).toBe("application/pdf");

    const receipts = await request(app).get("/v1/admin/receipts").set(auth(finance));
    expect(receipts.status).toBe(200);
    const row = receipts.body.data.find((r: { booker: { id: string } | null }) => r.booker?.id === booker.id);
    expect(row).toMatchObject({ status: "success", invoice_number: expect.stringMatching(/^INV\//) });
    const pdf = await request(app).get(`/v1/admin/receipts/${row.payment_id}/pdf`).set(auth(support));
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-disposition"]).toMatch(/RCPT-/);

    expect((await request(app).post(`/v1/admin/receipts/${row.payment_id}/send`).set(auth(support)).send({})).status).toBe(403);
    const sent = await request(app).post(`/v1/admin/receipts/${row.payment_id}/send`).set(auth(finance)).send({});
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(mock.sent.at(-1)).toMatchObject({ to: booker.email, subject: "Your payment receipt" });
    const again = await request(app).get("/v1/admin/receipts").set(auth(finance));
    expect(again.body.data.find((r: { payment_id: string }) => r.payment_id === row.payment_id).last_sent_at).not.toBeNull();
  });
});

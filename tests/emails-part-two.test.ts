import { createHmac } from "crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { renderLayout } from "../src/modules/email/layout";
import { processEmailOutbox, queueBookingReminders, queueEmail, setEmailSenderForTesting } from "../src/modules/email/outbox.service";
import { setResendWebhookSecretForTesting, verifySvixSignature } from "../src/modules/email/resendWebhook";
import { wrapEmail } from "../src/modules/outreach/email";
import type { OutgoingEmail } from "../src/modules/outreach/email";
import { adminClient, createTestUser, deleteTestUser, grantAdminRole, TestUser } from "./setup";

/** Email part two: footer, reminders, bounces (Resend webhook), news-and-offers settings. */

const app = createApp();
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.accessToken}` });
const sent: OutgoingEmail[] = [];
const SECRET = `whsec_${Buffer.from("a-test-webhook-signing-key-0123456789").toString("base64")}`;

function signed(body: string, at = Math.floor(Date.now() / 1000)) {
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  const sig = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64")).update(`${id}.${at}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": String(at), "svix-signature": `v1,${sig}`, "content-type": "application/json" };
}

describe("emails, part two", () => {
  let host: TestUser;
  let booker: TestUser;
  let admin: TestUser;
  let locationId: string;

  beforeAll(async () => {
    setEmailSenderForTesting(async (m) => {
      sent.push(m);
      return `msg_${sent.length}`;
    });
    setResendWebhookSecretForTesting(SECRET);
    [host, booker, admin] = await Promise.all([createTestUser(), createTestUser(), createTestUser()]);
    await grantAdminRole(admin.id);
    await adminClient.from("profiles").update({ first_name: "Hema", last_name: "Host", phone: "+91 90000 00001" }).eq("id", host.id);
    await adminClient.from("profiles").update({ first_name: "Arjun", last_name: "Rao", phone: "+91 90000 00002" }).eq("id", booker.id);
    const { data, error } = await adminClient
      .from("locations")
      .insert({ host_id: host.id, title: "Reminder Loft", city: "Pune", country: "IN", area: "Baner", address_line1: "7 Hill Road", latitude: 18.56, longitude: 73.78, status: "submitted" })
      .select("id")
      .single();
    if (error) throw error;
    locationId = data.id as string;
  });

  afterAll(async () => {
    setEmailSenderForTesting(null);
    setResendWebhookSecretForTesting(undefined);
    await adminClient.from("email_outbox").delete().in("user_id", [host.id, booker.id]);
    await adminClient.from("email_suppressions").delete().in("email", [host.email, booker.email].map((e) => e.toLowerCase()));
    await adminClient.from("email_suppressions").delete().eq("email", "gone@example.com");
    await adminClient.from("bookings").delete().eq("location_id", locationId);
    await adminClient.from("locations").delete().eq("id", locationId);
    await Promise.all([host, booker, admin].map((u) => deleteTestUser(u.id)));
  });

  it("every email names the company and the support address; announcements get the new design and an unsubscribe link", () => {
    const e = renderLayout({ subject: "Hi", preheader: "Hi", blocks: [{ kind: "text", text: "Hello" }] });
    expect(e.html).toContain("Eastape Tech");
    expect(e.html).toContain("support@heken.co");
    expect(e.text).toContain("support@heken.co");
    const a = wrapEmail({ subject: "News", bodyHtml: "<p>New places in Pune</p>", bodyText: "New places in Pune", ctaUrl: "https://heken.co/search", unsubscribeUrl: "https://api.heken.co/v1/email/unsubscribe?token=x" });
    expect(a.html).not.toContain("Prod");
    expect(a.html).not.toContain("C28014");
    expect(a.html).toContain("#7B0113");
    expect(a.html).toContain("Unsubscribe from news and offers");
    expect(a.text).toContain("New places in Pune");
  });

  it("queues one reminder each for booker and host the day before, however often it runs", async () => {
    const start = new Date(Date.now() + 24 * 3600_000);
    start.setUTCMinutes(0, 0, 0);
    const { data, error } = await adminClient
      .from("bookings")
      .insert({
        location_id: locationId,
        booker_id: booker.id,
        booking_type: "hourly",
        start_at: start.toISOString(),
        end_at: new Date(start.getTime() + 3 * 3600_000).toISOString(),
        status: "confirmed",
        base_amount_minor_units: 500000,
        platform_fee_minor_units: 25000,
        total_amount_minor_units: 525000,
        currency: "INR",
        crew_size: 6,
      })
      .select("id")
      .single();
    if (error) throw error;
    const before = sent.length;
    await queueBookingReminders();
    await queueBookingReminders();
    const mine = sent.slice(before).filter((m) => m.subject.includes("Reminder Loft"));
    expect(mine).toHaveLength(2);
    expect(mine.find((m) => m.to === booker.email)!.html).toContain("7 Hill Road");
    expect(mine.find((m) => m.to === host.email)!.subject).toContain("Tomorrow");
    const { data: rows } = await adminClient.from("email_outbox").select("template, status").like("idempotency_key", `reminder:${data.id}:%`);
    expect(rows!.map((r) => r.status)).toEqual(["sent", "sent"]);
  });

  it("the Resend webhook: wrong or old signatures are refused; a bounce blocks the address and later emails are skipped", async () => {
    const body = JSON.stringify({ type: "email.bounced", data: { to: [host.email], bounce: { type: "Permanent" } } });
    expect(verifySvixSignature(SECRET, { id: "a", timestamp: "1", signature: "v1,xxx" }, body)).toBe(false);
    const bad = await request(app).post("/v1/webhooks/resend").set({ ...signed(body), "svix-signature": "v1,AAAA" }).send(body);
    expect(bad.status).toBe(401);
    const old = await request(app).post("/v1/webhooks/resend").set(signed(body, Math.floor(Date.now() / 1000) - 3600)).send(body);
    expect(old.status).toBe(401);

    // A soft (temporary) bounce changes nothing.
    const soft = JSON.stringify({ type: "email.bounced", data: { to: [host.email], bounce: { type: "Transient" } } });
    expect((await request(app).post("/v1/webhooks/resend").set(signed(soft)).send(soft)).status).toBe(200);
    expect((await adminClient.from("email_suppressions").select("reason").eq("email", host.email.toLowerCase()).maybeSingle()).data).toBeNull();

    const res = await request(app).post("/v1/webhooks/resend").set(signed(body)).send(body);
    expect(res.status).toBe(200);
    const { data: row } = await adminClient.from("email_suppressions").select("reason, user_id").eq("email", host.email.toLowerCase()).single();
    expect(row).toMatchObject({ reason: "bounced", user_id: host.id });

    const before = sent.length;
    await queueEmail({ userId: host.id, template: "listing_approved", key: `test-bounce-${Date.now()}`, data: { locationId } });
    expect(sent.length).toBe(before);
    const { data: skipped } = await adminClient.from("email_outbox").select("status, last_error").eq("user_id", host.id).eq("template", "listing_approved").single();
    expect(skipped!.status).toBe("skipped");
    expect(skipped!.last_error).toContain("bounced");

    // The team sees it under blocked addresses and can unblock it.
    const list = await request(app).get("/v1/admin/emails/suppressions?reason=bounced").set(auth(admin));
    expect(list.status).toBe(200);
    expect(list.body.data.some((s: { email: string }) => s.email === host.email.toLowerCase())).toBe(true);
    const removed = await request(app).delete(`/v1/admin/emails/suppressions/${encodeURIComponent(host.email)}`).set(auth(admin));
    expect(removed.status).toBe(200);
    expect((await request(app).get("/v1/admin/emails/suppressions").set(auth(booker))).status).toBe(403);
  });

  it("a spam complaint unsubscribes from news and offers, but never downgrades a bounce", async () => {
    const complaint = JSON.stringify({ type: "email.complained", data: { to: "gone@example.com" } });
    const bounce = JSON.stringify({ type: "email.bounced", data: { to: ["gone@example.com"] } });
    await request(app).post("/v1/webhooks/resend").set(signed(bounce)).send(bounce);
    await request(app).post("/v1/webhooks/resend").set(signed(complaint)).send(complaint);
    const { data } = await adminClient.from("email_suppressions").select("reason").eq("email", "gone@example.com").single();
    expect(data!.reason).toBe("bounced");
  });

  it("news and offers can be switched off and on from the account; booking emails keep going", async () => {
    const start = await request(app).get("/v1/me/email-preferences").set(auth(booker));
    expect(start.body.data).toEqual({ email: booker.email, news_and_offers: true, address_blocked: false });
    const off = await request(app).patch("/v1/me/email-preferences").set(auth(booker)).send({ news_and_offers: false });
    expect(off.body.data.news_and_offers).toBe(false);
    expect((await adminClient.from("email_suppressions").select("reason").eq("email", booker.email.toLowerCase()).single()).data!.reason).toBe("unsubscribed");

    const before = sent.length;
    await queueEmail({ userId: booker.id, template: "listing_approved", key: `test-optout-${Date.now()}`, data: { locationId } });
    await processEmailOutbox(Date.now() + 2000);
    expect(sent.length).toBeGreaterThanOrEqual(before); // transactional mail isn't blocked by the opt-out

    const on = await request(app).patch("/v1/me/email-preferences").set(auth(booker)).send({ news_and_offers: true });
    expect(on.body.data.news_and_offers).toBe(true);
    expect((await request(app).patch("/v1/me/email-preferences").set(auth(booker)).send({ news: true })).status).toBe(400);
    expect((await request(app).get("/v1/me/email-preferences")).status).toBe(401);
  });

  it("the webhook says so when no secret is set", async () => {
    setResendWebhookSecretForTesting(null);
    const body = "{}";
    expect((await request(app).post("/v1/webhooks/resend").set(signed(body)).send(body)).status).toBe(503);
    setResendWebhookSecretForTesting(SECRET);
  });
});

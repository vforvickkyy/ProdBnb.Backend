import { createHmac } from "crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { setSmsHookSecretForTesting } from "../src/modules/sms/hooks";
import { processSmsOutbox, queueSms } from "../src/modules/sms/outbox.service";
import { PROVIDERS, setSmsFetchForTesting } from "../src/modules/sms/providers";
import { clearSmsCache } from "../src/modules/sms/settings.service";
import { dltForm, dltValue, normalizePhone, renderSms, smsSegments, smsWhen } from "../src/modules/sms/text";
import { adminClient, createTestUser, deleteTestUser, grantAdminRole, TestUser } from "./setup";

/** SMS: wording and DLT rules, test mode, a live provider (faked), delivery reports, sign-in codes, admin. */

const app = createApp();
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.accessToken}` });
const SECRET = `whsec_${Buffer.from("an-sms-hook-signing-key-0123456789abc").toString("base64")}`;

function signed(body: string) {
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  const at = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64")).update(`${id}.${at}.${body}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": String(at), "webhook-signature": `v1,${sig}`, "content-type": "application/json" };
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}
const calls: Call[] = [];

async function rows(userId: string) {
  const { data } = await adminClient.from("sms_outbox").select("*").eq("user_id", userId).order("created_at", { ascending: true });
  return (data ?? []) as Record<string, unknown>[];
}

async function resetSettings() {
  await adminClient.from("sms_settings").update({ mode: "test", active_provider: null, sender_id: null, dlt_entity_id: null, test_numbers: [], otp_per_hour: 5 }).eq("singleton", true);
  await adminClient.rpc("sms_provider_remove", { _provider: "msg91" });
  clearSmsCache();
}

describe("text rules", () => {
  it("normalises Indian mobile numbers and refuses landlines and junk", () => {
    expect(normalizePhone("+91 98765-43210")).toBe("+919876543210");
    expect(normalizePhone("098765 43210")).toBe("+919876543210");
    expect(normalizePhone("919876543210")).toBe("+919876543210");
    expect(normalizePhone("9876543210")).toBe("+919876543210");
    expect(normalizePhone("+91 2223456789")).toBeNull();
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("+1 415 555 0100")).toBe("+14155550100");
  });

  it("writes the DLT form with fixed brand and site, and {#var#} for the rest", () => {
    const form = dltForm("{code} is your {brand} code. See {site}/x for {name}.");
    expect(form).toMatch(/^\{#var#\} is your .+ code\. See [a-z0-9.:-]+\/x for \{#var#\}\.$/);
    expect(form).not.toContain("{brand}");
  });

  it("keeps each value at 30 plain characters, so the text matches DLT and stays cheap", () => {
    const long = dltValue("The Very Long Courtyard Bungalow With Arched Windows");
    expect(long.length).toBeLessThanOrEqual(30);
    expect(dltValue("₹12,500 – “quoted”")).toBe('Rs.12,500 - "quoted"');
    const text = renderSms("Booking {ref}: {place}, {when}.", { ref: "AB12", place: "Café Loft", when: null });
    expect(text).toBe("Booking AB12: Cafe Loft, -.");
    expect(smsSegments(text)).toEqual({ encoding: "GSM-7", characters: text.length, segments: 1 });
    expect(smsSegments("नमस्ते").encoding).toBe("Unicode");
    expect(smsSegments("a".repeat(161)).segments).toBe(2);
  });

  it("shows times short, in the place's time zone", () => {
    expect(smsWhen("2026-11-27T03:00:00Z", "2026-11-27T12:30:00Z")).toBe("Fri 27 Nov, 8:30 am-6 pm");
    expect(smsWhen("2026-11-27T03:00:00Z", "2026-11-28T12:30:00Z")).toBe("27 Nov 8:30 am-28 Nov 6 pm");
    expect(smsWhen("2026-11-27T03:00:00Z", "2026-11-28T12:30:00Z").length).toBeLessThanOrEqual(30);
  });
});

describe("SMS system", () => {
  let host: TestUser;
  let admin: TestUser;
  let locationId: string;

  beforeAll(async () => {
    setSmsHookSecretForTesting(SECRET);
    await resetSettings();
    [host, admin] = await Promise.all([createTestUser(), createTestUser()]);
    await grantAdminRole(admin.id);
    await adminClient.from("profiles").update({ first_name: "Hema", last_name: "Host", phone: "+91 90000 00011" }).eq("id", host.id);
    const { data, error } = await adminClient
      .from("locations")
      .insert({ host_id: host.id, title: "Text Message Loft", city: "Pune", country: "IN", area: "Baner", address_line1: "7 Hill Road", latitude: 18.56, longitude: 73.78, status: "submitted" })
      .select("id")
      .single();
    if (error) throw error;
    locationId = data.id as string;
    setSmsFetchForTesting(async (url, init) => {
      const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      calls.push({ url: String(url), headers, body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ type: "success", message: `req-${calls.length}` }), { status: 200 });
    });
  });

  afterAll(async () => {
    setSmsFetchForTesting(null);
    setSmsHookSecretForTesting(undefined);
    await resetSettings();
    await adminClient.from("sms_outbox").delete().in("user_id", [host.id, admin.id]);
    await adminClient.from("sms_outbox").delete().in("to_phone", ["+919000000012", "+919000000013"]);
    await adminClient.from("locations").delete().eq("id", locationId);
    await Promise.all([host, admin].map((u) => deleteTestUser(u.id)));
  });

  it("test mode: the text is written to the log with the real wording and nothing is sent", async () => {
    await queueSms({ userId: host.id, template: "listing_rejected", key: `t:${locationId}:rejected`, data: { locationId } });
    const [row] = await rows(host.id);
    expect(row).toMatchObject({ status: "sent", mode: "test", provider: "test", to_phone: "+919000000011", segments: 1 });
    expect(row!.body).toContain("Hi Hema, Text Message Loft needs a few changes");
    expect(calls).toHaveLength(0);
    // Same key twice: one text.
    await queueSms({ userId: host.id, template: "listing_rejected", key: `t:${locationId}:rejected`, data: { locationId } });
    expect(await rows(host.id)).toHaveLength(1);
  });

  it("optional texts respect the person's switch; booking and payment texts don't", async () => {
    const off = await request(app).patch("/v1/me/sms-preferences").set(auth(host)).send({ sms_updates: false });
    expect(off.status).toBe(200);
    expect(off.body.data).toEqual({ phone: expect.stringContaining("+91 90"), has_phone: true, sms_updates: false });
    await adminClient.from("locations").update({ status: "published" }).eq("id", locationId);
    await queueSms({ userId: host.id, template: "listing_approved", key: `t:${locationId}:approved`, data: { locationId } });
    const approved = (await rows(host.id)).find((r) => r.template === "listing_approved");
    expect(approved).toMatchObject({ status: "skipped", last_error: "This person switched off optional texts." });
    await request(app).patch("/v1/me/sms-preferences").set(auth(host)).send({ sms_updates: true });
  });

  it("admin: connect a provider without ever reading its key back, edit wording and DLT ids", async () => {
    const save = await request(app).put("/v1/admin/sms/providers/msg91").set(auth(admin)).send({ auth_key: "secret-msg91-key-123", route: "4" });
    expect(save.status).toBe(200);
    expect(JSON.stringify(save.body)).not.toContain("secret-msg91-key-123");
    const msg91 = save.body.data.providers.find((p: { id: string }) => p.id === "msg91");
    expect(msg91).toMatchObject({ connected: true, config: { route: "4" } });
    expect(save.body.data.report_urls.msg91).toMatch(/\/v1\/webhooks\/sms\/msg91\?token=[0-9a-f]{36}$/);
  });

  it("admin: live needs a chosen provider; sender and DLT ids are checked", async () => {
    await adminClient.from("sms_settings").update({ mode: "test", active_provider: null }).eq("singleton", true);
    clearSmsCache();
    const bad = await request(app).patch("/v1/admin/sms/settings").set(auth(admin)).send({ mode: "live" });
    expect(bad.status).toBe(400);
    const badSender = await request(app).patch("/v1/admin/sms/settings").set(auth(admin)).send({ sender_id: "HEKEN-S" });
    expect(badSender.status).toBe(400);
    const okRes = await request(app)
      .patch("/v1/admin/sms/settings")
      .set(auth(admin))
      .send({ mode: "live", active_provider: "msg91", sender_id: "hekens", dlt_entity_id: "1201160000000012345" });
    expect(okRes.status).toBe(200);
    expect(okRes.body.data.settings).toMatchObject({ mode: "live", active_provider: "msg91", sender_id: "HEKENS" });
    expect(okRes.body.data.settings.webhook_token).toBeUndefined();

    const tpl = await request(app).patch("/v1/admin/sms/templates/listing_rejected").set(auth(admin)).send({ dlt_template_id: "1207160000000099999" });
    expect(tpl.status).toBe(200);
    expect(tpl.body.data.dlt_text).toContain("{#var#}");
    const unknown = await request(app).patch("/v1/admin/sms/templates/listing_rejected").set(auth(admin)).send({ body: "Hi {nmae}, check {site}." });
    expect(unknown.status).toBe(400);
    const otpOff = await request(app).patch("/v1/admin/sms/templates/auth_otp").set(auth(admin)).send({ enabled: false });
    expect(otpOff.status).toBe(400);
    const list = await request(app).get("/v1/admin/sms/templates").set(auth(admin));
    expect(list.body.data.length).toBeGreaterThanOrEqual(18);
    for (const t of list.body.data as { preview: { characters: number; encoding: string }; key: string }[]) {
      expect(t.preview.encoding, t.key).toBe("GSM-7");
    }
  });

  it("live: the provider gets the wording, sender and DLT template id; its delivery report marks the text delivered", async () => {
    calls.length = 0;
    await queueSms({ userId: host.id, template: "listing_rejected", key: `t:${locationId}:rejected:live`, data: { locationId } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.msg91.com/api/v2/sendsms");
    expect(calls[0]!.headers.authkey).toBe("secret-msg91-key-123");
    const sent = JSON.parse(calls[0]!.body);
    expect(sent).toMatchObject({ sender: "HEKENS", route: "4", country: "91", DLT_TE_ID: "1207160000000099999", sms: [{ to: ["9000000011"] }] });
    const row = (await rows(host.id)).find((r) => r.idempotency_key === `t:${locationId}:rejected:live`)!;
    expect(row).toMatchObject({ status: "sent", mode: "live", provider: "msg91", provider_message_id: "req-1" });

    const { data: s } = await adminClient.from("sms_settings").select("webhook_token").single();
    const wrong = await request(app).post("/v1/webhooks/sms/msg91?token=nope").type("form").send({ data: "[]" });
    expect(wrong.status).toBe(401);
    const report = await request(app)
      .post(`/v1/webhooks/sms/msg91?token=${s!.webhook_token}`)
      .type("form")
      .send({ data: JSON.stringify([{ requestId: "req-1", report: [{ status: "1", desc: "DELIVERED", number: "919000000011" }] }]) });
    expect(report.body).toEqual({ received: 1, updated: 1 });
    const after = (await rows(host.id)).find((r) => r.id === row.id)!;
    expect(after.status).toBe("delivered");
    expect(after.delivered_at).toBeTruthy();
  });

  it("a provider failure is retried later, not lost", async () => {
    setSmsFetchForTesting(async () => new Response(JSON.stringify({ type: "error", message: "Invalid DLT template" }), { status: 400 }));
    await queueSms({ userId: host.id, template: "listing_rejected", key: `t:${locationId}:rejected:fail`, data: { locationId } });
    const row = (await rows(host.id)).find((r) => r.idempotency_key === `t:${locationId}:rejected:fail`)!;
    expect(row).toMatchObject({ status: "queued", attempts: 1 });
    expect(row.last_error).toContain("Invalid DLT template");
    // Due now: the dispatcher sends it once the provider answers again.
    setSmsFetchForTesting(async () => new Response(JSON.stringify({ type: "success", message: "req-retry" }), { status: 200 }));
    await adminClient.from("sms_outbox").update({ send_after: new Date().toISOString() }).eq("id", row.id);
    await processSmsOutbox(Date.now() + 5000);
    const after = (await rows(host.id)).find((r) => r.id === row.id)!;
    expect(after).toMatchObject({ status: "sent", provider_message_id: "req-retry", attempts: 2 });
  });

  it("sign-in codes: the Supabase hook is signed, codes are masked in live, shown in test, and limited per hour", async () => {
    // Live: masked.
    const body = JSON.stringify({ user: { id: null, phone: "919000000012" }, sms: { otp: "482913" } });
    const unsigned = await request(app).post("/v1/auth/sms-hook").set({ "content-type": "application/json" }).send(body);
    expect(unsigned.status).toBe(401);
    const res = await request(app).post("/v1/auth/sms-hook").set(signed(body)).send(body);
    expect(res.status).toBe(200);
    const { data: liveRow } = await adminClient.from("sms_outbox").select("*").eq("to_phone", "+919000000012").single();
    expect(liveRow).toMatchObject({ template: "auth_otp", status: "sent", mode: "live", provider: "msg91" });
    expect(liveRow!.body).not.toContain("482913");
    expect(liveRow!.body).toContain("••••••");

    // Test mode, not a test number: logged only, code visible so the team can sign in.
    await adminClient.from("sms_settings").update({ mode: "test", otp_per_hour: 2 }).eq("singleton", true);
    clearSmsCache();
    const b2 = JSON.stringify({ user: { phone: "919000000013" }, sms: { otp: "111222" } });
    expect((await request(app).post("/v1/auth/sms-hook").set(signed(b2)).send(b2)).status).toBe(200);
    const b3 = JSON.stringify({ user: { phone: "919000000013" }, sms: { otp: "333444" } });
    expect((await request(app).post("/v1/auth/sms-hook").set(signed(b3)).send(b3)).status).toBe(200);
    const { data: testRows } = await adminClient.from("sms_outbox").select("body, provider, mode").eq("to_phone", "+919000000013");
    expect(testRows!.map((r) => r.body)).toEqual(expect.arrayContaining([expect.stringContaining("111222")]));
    expect(testRows!.every((r) => r.provider === "test" && r.mode === "test")).toBe(true);
    const b4 = JSON.stringify({ user: { phone: "919000000013" }, sms: { otp: "555666" } });
    const limited = await request(app).post("/v1/auth/sms-hook").set(signed(b4)).send(b4);
    expect(limited.status).toBe(429);
    expect(limited.body.error.message).toContain("Too many codes");
  });

  it("admin: test send, log with masked numbers, summary", async () => {
    calls.length = 0;
    setSmsFetchForTesting(async (url, init) => {
      calls.push({ url: String(url), headers: {}, body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ type: "success", message: "req-test" }), { status: 200 });
    });
    // Test mode + a test number + a connected provider = a real text to that number only.
    await request(app).patch("/v1/admin/sms/settings").set(auth(admin)).send({ test_numbers: ["90000 00011"] });
    const t = await request(app).post("/v1/admin/sms/test").set(auth(admin)).send({ phone: "+91 90000 00011", template: "booking_confirmed" });
    expect(t.status).toBe(200);
    expect(t.body.data).toMatchObject({ status: "sent", provider: "msg91", mode: "test" });
    expect(calls).toHaveLength(1);
    const notTest = await request(app).post("/v1/admin/sms/test").set(auth(admin)).send({ phone: "+91 90000 00099" });
    expect(notTest.body.data).toMatchObject({ status: "sent", provider: "test" });
    expect(calls).toHaveLength(1);

    const log = await request(app).get("/v1/admin/sms?search=00011").set(auth(admin));
    expect(log.status).toBe(200);
    expect(log.body.data[0].to_phone_masked).toMatch(/^\+91 90•+011$/);
    const summary = await request(app).get("/v1/admin/sms/summary").set(auth(admin));
    expect(summary.body.data.sent).toBeGreaterThan(0);
    await adminClient.from("sms_outbox").delete().eq("to_phone", "+919000000099");
  });

  it("each provider reads its own delivery reports", () => {
    expect(PROVIDERS.twilio.parseReports({ MessageSid: "SM1", MessageStatus: "delivered" })).toEqual([{ messageId: "SM1", status: "delivered" }]);
    expect(PROVIDERS.twilio.parseReports({ MessageSid: "SM1", MessageStatus: "queued" })).toEqual([]);
    expect(PROVIDERS.gupshup.parseReports({ externalId: "G1", status: "FAIL", cause: "DND" })).toEqual([{ messageId: "G1", status: "failed", error: "DND" }]);
    expect(PROVIDERS.twofactor.parseReports({ SessionId: "F1", Status: "DELIVERED" })).toEqual([{ messageId: "F1", status: "delivered" }]);
    expect(PROVIDERS.msg91.parseReports({ data: [{ requestId: "M1", report: [{ status: "2", desc: "FAILED" }] }] })).toEqual([{ messageId: "M1", status: "failed", error: "FAILED" }]);
  });
});

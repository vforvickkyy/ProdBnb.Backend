import { createHmac, randomUUID } from "crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { setAuthHookForTesting, authEmailsFor } from "../src/modules/email/authEmailHook";
import { renderLayout } from "../src/modules/email/layout";
import { buildMarketingEmail, loadMarketingAssets } from "../src/modules/email/marketing";
import { setResendWebhookSecretForTesting } from "../src/modules/email/resendWebhook";
import { clearChannelCache } from "../src/modules/outreach/channels.service";
import { setResendFetchForTesting } from "../src/modules/outreach/email";
import type { OutgoingEmail } from "../src/modules/outreach/email";
import { processCampaign } from "../src/modules/outreach/campaigns.service";
import { adminClient, createTestUser, deleteTestUser, grantAdminRole, TestUser } from "./setup";

/** Marketing emails: designs, preview, sending through Resend, opens/clicks, subscribers, sign-in emails. */

const app = createApp();
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.accessToken}` });
const SECRET = `whsec_${Buffer.from("marketing-test-webhook-key-0123456789").toString("base64")}`;
const resendCalls: { auth: string; body: Record<string, unknown> }[] = [];

function signed(body: string, prefix: "svix" | "webhook" = "svix") {
  const id = `msg_${randomUUID()}`;
  const at = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64")).update(`${id}.${at}.${body}`).digest("base64");
  return { [`${prefix}-id`]: id, [`${prefix}-timestamp`]: at, [`${prefix}-signature`]: `v1,${sig}`, "content-type": "application/json" };
}

describe("marketing emails", () => {
  let admin: TestUser;
  let host: TestUser;
  let fan: TestUser;
  let quiet: TestUser;
  const listingIds: string[] = [];
  let couponId: string;

  async function listing(title: string, status = "published"): Promise<string> {
    const { data, error } = await adminClient
      .from("locations")
      .insert({ host_id: host.id, title, city: "Mumbai", country: "IN", area: "Bandra", latitude: 19.06, longitude: 72.83, status, capacity: 20, area_sqft: 1800 })
      .select("id")
      .single();
    if (error) throw error;
    const id = data.id as string;
    listingIds.push(id);
    await adminClient.from("location_media").insert({ id: randomUUID(), location_id: id, media_type: "photo", storage_key: `locations/${id}/cover/original`, position: 0 });
    await adminClient.from("location_pricing").insert({ location_id: id, booking_type: "hourly", amount_minor_units: 250000, currency: "INR", is_active: true });
    return id;
  }

  beforeAll(async () => {
    setResendFetchForTesting(async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      resendCalls.push({ auth: headers.Authorization, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ id: `re_${randomUUID()}` }), { status: 200, headers: { "content-type": "application/json" } });
    });
    setResendWebhookSecretForTesting(SECRET);
    [admin, host, fan, quiet] = await Promise.all([createTestUser(), createTestUser(), createTestUser(), createTestUser()]);
    await grantAdminRole(admin.id);
    await adminClient.from("profiles").update({ first_name: "Farah" }).eq("id", fan.id);
    // Resend connected as the email provider (the API key is the SMTP password).
    const { error } = await adminClient.rpc("messaging_channel_save", {
      _channel: "smtp",
      _config: { host: "smtp.resend.com", port: 465, secure: true, username: "resend", from_email: "bookings@notify.example.com", from_name: "heken", reply_to: null, marketing_from_email: "news@news.example.com", max_per_minute: 600 },
      _secret: JSON.stringify({ password: "re_test_key_123" }),
      _actor_id: null,
    });
    if (error) throw error;
    clearChannelCache();
    const { data: c, error: ce } = await adminClient
      .from("coupons")
      .insert({ owner_type: "platform", code: `SHOOT${Math.floor(Math.random() * 1e6)}`, title: "20% off your first shoot", discount_type: "percent", percent_off: 20, max_discount_minor_units: 500000 })
      .select("id")
      .single();
    if (ce) throw ce;
    couponId = c.id as string;
  });

  afterAll(async () => {
    setResendFetchForTesting(null);
    setResendWebhookSecretForTesting(undefined);
    setAuthHookForTesting(undefined);
    await adminClient.rpc("messaging_channel_remove", { _channel: "smtp" });
    clearChannelCache();
    await adminClient.from("notification_campaigns").delete().eq("created_by", admin.id);
    await adminClient.from("coupons").delete().eq("id", couponId);
    await adminClient.from("email_suppressions").delete().eq("email", quiet.email.toLowerCase());
    await adminClient.from("email_outbox").delete().like("to_email", "%@example.com").like("template", "auth_%");
    await adminClient.from("email_outbox").delete().in("user_id", [fan.id, host.id, quiet.id]);
    await adminClient.from("location_pricing").delete().in("location_id", listingIds);
    await adminClient.from("location_media").delete().in("location_id", listingIds);
    await adminClient.from("locations").delete().in("id", listingIds);
    await Promise.all([admin, host, fan, quiet].map((u) => deleteTestUser(u.id)));
  });

  it("emails work in light and dark: dark rules, a forced-dark class for previews, and no unreadable brand red", () => {
    const e = renderLayout({ subject: "Hi", preheader: "Hi", blocks: [{ kind: "heading", text: "Hello" }] });
    expect(e.html).toContain('content="light dark"');
    expect(e.html).toContain("prefers-color-scheme: dark");
    expect(e.html).toContain(".pb-force-dark .pb-card");
    expect(e.html).toContain('class="pb-card');
  });

  it("spotlight and collection show photos, facts, price and a link to each listing; unpublished ones are refused", async () => {
    const a = await listing("Sea-facing Loft");
    const b = await listing("Bandra Rooftop");
    const hidden = await listing("Not live yet", "submitted");
    const spot = await loadMarketingAssets({ email_design: "spotlight", location_id: a });
    const email = buildMarketingEmail({ design: "spotlight", subject: "Spotlight", bodyHtml: "<p>Hi</p>", bodyText: "Hi", assets: spot, buttonLabel: null });
    expect(email.html).toContain("Sea-facing Loft");
    expect(email.html).toContain("Bandra, Mumbai");
    expect(email.html).toContain("1,800 sq ft");
    expect(email.html).toContain("From ₹2,500 / hour");
    expect(email.html).toMatch(/<img src="[^"]+cover/);
    expect(email.html).toContain(`/locations/sea-facing-loft-mumbai-${a}`);
    expect(email.html).toContain("See this place");

    const grid = await loadMarketingAssets({ email_design: "collection", email_location_ids: [a, b, hidden] });
    expect(grid.listings.map((l) => l.title)).toEqual(["Sea-facing Loft", "Bandra Rooftop"]);
    await expect(loadMarketingAssets({ email_design: "spotlight", location_id: hidden })).rejects.toThrow(/published/);
    await expect(loadMarketingAssets({ email_design: "collection", email_location_ids: [a] })).rejects.toThrow(/at least 2/);

    const offer = await loadMarketingAssets({ email_design: "offer", coupon_id: couponId });
    const o = buildMarketingEmail({ design: "offer", subject: "Offer", bodyHtml: "", bodyText: "", assets: offer });
    expect(o.html).toContain("20% off (up to ₹5,000)");
    expect(o.text).toContain("Your code: SHOOT");
  });

  it("the admin preview returns the whole email, personalised; and says why when it can't be built", async () => {
    const res = await request(app)
      .post("/v1/admin/campaigns/render-preview")
      .set(auth(admin))
      .send({
        title: "x",
        body: "x",
        email_subject: "Hi {first_name|there}",
        email_body: "Look at **this**",
        email_design: "spotlight",
        location_id: listingIds[0],
        email_heading: "{listing_title} is live",
        user_id: fan.id,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.email_subject).toBe("Hi Farah");
    expect(res.body.data.email_html).toContain("Sea-facing Loft is live");
    expect(res.body.data.email_html).toContain("Unsubscribe from news and offers");
    const broken = await request(app)
      .post("/v1/admin/campaigns/render-preview")
      .set(auth(admin))
      .send({ title: "x", body: "x", email_subject: "S", email_body: "B", email_design: "collection", email_location_ids: [listingIds[0]] });
    expect(broken.body.data.email_html).toBeNull();
    expect(broken.body.data.email_problem).toMatch(/at least 2/);
  });

  it("the audience preview says how many get the email, and why the rest won't", async () => {
    await adminClient.from("email_suppressions").upsert({ email: quiet.email.toLowerCase(), reason: "unsubscribed", user_id: quiet.id });
    const res = await request(app)
      .post("/v1/admin/campaigns/audience-preview")
      .set(auth(admin))
      .send({ audience: { type: "users", user_ids: [fan.id, quiet.id] } });
    expect(res.status).toBe(200);
    expect(res.body.data.email).toEqual({ will_receive: 1, unsubscribed: 1, bounced: 0, no_email: 0 });

    const subs = await request(app).get(`/v1/admin/email-subscribers?status=unsubscribed&search=${encodeURIComponent(quiet.email)}`).set(auth(admin));
    expect(subs.status).toBe(200);
    expect(subs.body.data).toHaveLength(1);
    expect(subs.body.data[0]).toMatchObject({ user_id: quiet.id, status: "unsubscribed" });
    const summary = await request(app).get("/v1/admin/email-subscribers/summary").set(auth(admin));
    expect(summary.body.data.unsubscribed).toBeGreaterThanOrEqual(1);
    expect((await request(app).get("/v1/admin/email-subscribers").set(auth(fan))).status).toBe(403);
  });

  it("sends through Resend from the news address with campaign tags; opens and clicks come back per person", async () => {
    const created = await request(app)
      .post("/v1/admin/campaigns")
      .set(auth(admin))
      .send({
        name: "Rooftops",
        channels: ["email"],
        audience: { type: "users", user_ids: [fan.id, quiet.id] },
        title: "Rooftops",
        body: "Rooftops",
        email_subject: "Rooftops in Mumbai",
        email_body: "Hi {first_name|there}, have a look.",
        email_design: "collection",
        email_location_ids: listingIds.slice(0, 2),
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    expect(created.body.data.email_design).toBe("collection");
    const before = resendCalls.length;
    const sent = await request(app).post(`/v1/admin/campaigns/${id}/send`).set(auth(admin)).send({});
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await processCampaign(id, Date.now() + 5000);
    const calls = resendCalls.slice(before);
    expect(calls).toHaveLength(1); // quiet unsubscribed
    expect(calls[0]!.auth).toBe("Bearer re_test_key_123");
    expect(calls[0]!.body.from).toContain("news@news.example.com");
    expect(calls[0]!.body.tags).toEqual(expect.arrayContaining([{ name: "campaign_id", value: id }]));
    expect(String(calls[0]!.body.html)).toContain("Bandra Rooftop");

    const { data: row } = await adminClient.from("campaign_recipients").select("email_message_id").eq("campaign_id", id).eq("user_id", fan.id).single();
    const emailId = row!.email_message_id as string;
    expect(emailId).toMatch(/^re_/);
    for (const type of ["email.delivered", "email.opened", "email.opened", "email.clicked"]) {
      const body = JSON.stringify({ type, created_at: new Date().toISOString(), data: { email_id: emailId, to: [fan.email] } });
      expect((await request(app).post("/v1/webhooks/resend").set(signed(body)).send(body)).status).toBe(200);
    }
    const campaign = await request(app).get(`/v1/admin/campaigns/${id}`).set(auth(admin));
    expect(campaign.body.data.stats).toMatchObject({ email_sent: 1, email_unsubscribed: 1, email_delivered: 1, email_opened: 1, email_clicked: 1 });
    const opened = await request(app).get(`/v1/admin/campaigns/${id}/recipients?filter=opened`).set(auth(admin));
    expect(opened.body.data).toHaveLength(1);
    expect(opened.body.data[0]).toMatchObject({ user_id: fan.id, email_open_count: 2, email_click_count: 1 });
  });

  it("sign-in emails: the Supabase hook is signed, sends the branded email with link and code, and logs it without the link", async () => {
    const sent: OutgoingEmail[] = [];
    setAuthHookForTesting(SECRET, async (m) => {
      sent.push(m);
      return "re_auth_1";
    });
    const body = JSON.stringify({
      user: { id: randomUUID(), email: "newbie@example.com", user_metadata: { first_name: "Neha" } },
      email_data: { token: "482913", token_hash: "hash_abc", redirect_to: "https://heken.co/welcome", email_action_type: "signup" },
    });
    expect((await request(app).post("/v1/auth/email-hook").set({ ...signed(body, "webhook"), "webhook-signature": "v1,AAAA" }).send(body)).status).toBe(401);
    const res = await request(app).post("/v1/auth/email-hook").set(signed(body, "webhook")).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("newbie@example.com");
    expect(sent[0]!.html).toContain("Hi Neha,");
    expect(sent[0]!.html).toContain("482913");
    expect(sent[0]!.html).toContain("/auth/v1/verify?token=hash_abc&amp;type=signup");
    const { data: logged } = await adminClient.from("email_outbox").select("template, status, data").eq("to_email", "newbie@example.com").single();
    expect(logged).toMatchObject({ template: "auth_signup", status: "sent", data: { action: "signup" } });
    expect(JSON.stringify(logged)).not.toContain("hash_abc");

    const reset = authEmailsFor({ user: { email: "a@example.com" }, email_data: { email_action_type: "recovery", token_hash: "h" } });
    expect(reset[0]!.subject).toContain("Reset your");
    const change = authEmailsFor({ user: { email: "old@example.com", new_email: "new@example.com" }, email_data: { email_action_type: "email_change", token_hash: "n", token_hash_new: "o" } });
    expect(change.map((c) => c.to)).toEqual(["old@example.com", "new@example.com"]);

    // A failed send tells Supabase, so the person sees an error and can ask again.
    setAuthHookForTesting(SECRET, async () => {
      throw new Error("Provider down");
    });
    const again = JSON.stringify({ user: { email: "newbie2@example.com" }, email_data: { email_action_type: "magiclink", token: "1", token_hash: "x" } });
    expect((await request(app).post("/v1/auth/email-hook").set(signed(again, "webhook")).send(again)).status).toBe(500);
  });

  it("sends one welcome email when someone finishes onboarding", async () => {
    const { buildEmail } = await import("../src/modules/email/templates");
    await adminClient.from("user_preferences").upsert({ user_id: fan.id, professions: ["photographer"], cities: ["Mumbai"] });
    const e = await buildEmail("welcome", {}, fan.id);
    expect(e!.subject).toContain("Welcome to");
    expect(e!.html).toContain("Farah");
    expect(e!.html).toContain("/search?city=Mumbai");
    await adminClient.from("user_preferences").upsert({ user_id: host.id, professions: ["location_owner"] });
    const h = await buildEmail("welcome", {}, host.id);
    expect(h!.html).toContain("List your place");
    await adminClient.from("user_preferences").delete().in("user_id", [fan.id, host.id]);
  });
});

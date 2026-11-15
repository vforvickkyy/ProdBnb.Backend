import { randomUUID } from "crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Web Push is mocked at the library boundary: key generation stays real (it is pure crypto), only
// the network call to the browser's push service is captured.
const pushes = vi.hoisted(() => ({ sent: [] as { endpoint: string; payload: string }[] }));
vi.mock("web-push", async (importOriginal) => {
  const actual = (await importOriginal()) as { default: Record<string, unknown> };
  return {
    default: {
      ...actual.default,
      sendNotification: async (subscription: { endpoint: string }, payload: string) => {
        pushes.sent.push({ endpoint: subscription.endpoint, payload });
        return { statusCode: 201, headers: {}, body: "" };
      },
    },
  };
});

import { createApp } from "../src/app";
import { clearChannelCache } from "../src/modules/outreach/channels.service";
import { setEmailTransportForTesting } from "../src/modules/outreach/email";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

const app = createApp();

const mail = { sent: [] as { to: string; subject: string; html: string; text: string; headers?: Record<string, string> }[] };
setEmailTransportForTesting({
  async sendMail(message: { to: string; subject: string; html: string; text: string; headers?: Record<string, string> }) {
    mail.sent.push(message);
    return { messageId: `<${randomUUID()}@test>` };
  },
  async verify() {
    return true;
  },
} as never);

function auth(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${user.accessToken}` };
}

async function makeAdmin(user: TestUser, teamRole: "super_admin" | "moderator" | "support" | "finance"): Promise<void> {
  const { error } = await adminClient.from("user_roles").insert({ user_id: user.id, role: "admin" });
  if (error) throw error;
  if (teamRole !== "super_admin") {
    const { error: roleError } = await adminClient.from("admin_team_members").update({ team_role: teamRole }).eq("user_id", user.id);
    if (roleError) throw roleError;
  }
}

const SMTP_PASSWORD = `pw-${randomUUID()}`;

describe("Admin Console 2: messaging channels, announcements and direct notifications", () => {
  let superAdmin: TestUser;
  let support: TestUser;
  let moderator: TestUser;
  let finance: TestUser;
  let alice: TestUser;
  let bob: TestUser;
  const campaignIds: string[] = [];

  beforeAll(async () => {
    [superAdmin, support, moderator, finance, alice, bob] = await Promise.all([
      createTestUser(),
      createTestUser(),
      createTestUser(),
      createTestUser(),
      createTestUser(),
      createTestUser(),
    ]);
    await makeAdmin(superAdmin, "super_admin");
    await makeAdmin(support, "support");
    await makeAdmin(moderator, "moderator");
    await makeAdmin(finance, "finance");
  });

  afterAll(async () => {
    for (const channel of ["smtp", "webpush"]) {
      await adminClient.rpc("messaging_channel_remove", { _channel: channel });
    }
    clearChannelCache();
    if (campaignIds.length > 0) {
      await adminClient.from("notification_campaigns").delete().in("id", campaignIds);
    }
    await adminClient.from("email_suppressions").delete().in("email", [alice.email.toLowerCase(), bob.email.toLowerCase()]);
    await adminClient.from("background_jobs_config").update({ enabled: false, dispatch_url: null }).eq("singleton", true);
    for (const user of [superAdmin, support, moderator, finance, alice, bob]) {
      await deleteTestUser(user.id);
    }
  });

  // -- Channels ----------------------------------------------------------------------------------

  it("connects SMTP write-only: the password goes to Vault and never comes back", async () => {
    const base = {
      channel: "smtp",
      host: "smtp.example.com",
      port: 587,
      secure: false,
      username: "mailer",
      from_email: "hello@prodbnb.test",
      from_name: "ProdBnb",
      max_per_minute: 100,
    };
    // Not connected yet and no password -> refused.
    await request(app).put("/v1/admin/messaging/channels/smtp").set(auth(superAdmin)).send(base).expect(400);
    // Only super admins hold channels.manage.
    await request(app).put("/v1/admin/messaging/channels/smtp").set(auth(support)).send({ ...base, password: SMTP_PASSWORD }).expect(403);

    const res = await request(app)
      .put("/v1/admin/messaging/channels/smtp")
      .set(auth(superAdmin))
      .send({ ...base, password: SMTP_PASSWORD })
      .expect(200);
    expect(res.body.data).toMatchObject({ channel: "smtp", connected: true, source: "dashboard", config: { host: "smtp.example.com" } });
    expect(JSON.stringify(res.body)).not.toContain(SMTP_PASSWORD);

    const overview = await request(app).get("/v1/admin/messaging/overview").set(auth(support)).expect(200);
    expect(JSON.stringify(overview.body)).not.toContain(SMTP_PASSWORD);
    expect(overview.body.data.readiness.email).toBe(true);

    const { data: secret } = await adminClient.rpc("messaging_channel_secret", { _channel: "smtp" });
    expect(JSON.parse(secret as string)).toEqual({ password: SMTP_PASSWORD });

    const { data: audit } = await adminClient
      .from("admin_audit_log")
      .select("metadata")
      .eq("action", "ADMIN_CONNECTED_CHANNEL")
      .eq("admin_id", superAdmin.id);
    expect(JSON.stringify(audit)).not.toContain(SMTP_PASSWORD);

    // Editing settings without re-entering the password keeps the stored one.
    await request(app)
      .put("/v1/admin/messaging/channels/smtp")
      .set(auth(superAdmin))
      .send({ ...base, from_name: "ProdBnb Team" })
      .expect(200);
    const { data: kept } = await adminClient.rpc("messaging_channel_secret", { _channel: "smtp" });
    expect(JSON.parse(kept as string)).toEqual({ password: SMTP_PASSWORD });
  });

  it("sends a test email to the signed-in admin and records the result", async () => {
    mail.sent.length = 0;
    const res = await request(app).post("/v1/admin/messaging/channels/smtp/test").set(auth(superAdmin)).send({}).expect(200);
    expect(res.body.data.ok).toBe(true);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe(superAdmin.email);
    const { data } = await adminClient.from("messaging_channels").select("last_test_ok").eq("channel", "smtp").single();
    expect(data?.last_test_ok).toBe(true);
  });

  it("generates VAPID keys for Web Push and publishes only the public key", async () => {
    const res = await request(app)
      .put("/v1/admin/messaging/channels/webpush")
      .set(auth(superAdmin))
      .send({ channel: "webpush", subject: "mailto:ops@prodbnb.test", generate_keys: true })
      .expect(200);
    const publicKey = res.body.data.config.public_key as string;
    expect(publicKey.length).toBeGreaterThan(40);
    const pub = await request(app).get("/v1/push/web/public-key").expect(200);
    expect(pub.body.data.public_key).toBe(publicKey);
    const check = await request(app).post("/v1/admin/messaging/channels/webpush/test").set(auth(superAdmin)).send({}).expect(200);
    expect(check.body.data.ok).toBe(true);
  });

  it("registers web push devices only with subscription keys and an https endpoint", async () => {
    await request(app)
      .post("/v1/devices")
      .set(auth(alice))
      .send({ platform: "web", device_token: "https://push.example.test/sub/alice" })
      .expect(400);
    const res = await request(app)
      .post("/v1/devices")
      .set(auth(alice))
      .send({
        platform: "web",
        device_token: `https://push.example.test/sub/${randomUUID()}`,
        app_version: "1.0.0",
        web_push_keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" },
      })
      .expect(201);
    expect(res.body.data).toMatchObject({ platform: "web", app_version: "1.0.0" });
  });

  // -- Campaigns -------------------------------------------------------------------------------------

  async function createCampaign(as: TestUser, body: Record<string, unknown>) {
    const res = await request(app)
      .post("/v1/admin/campaigns")
      .set(auth(as))
      .send({
        name: "Launch week",
        channels: ["push", "email"],
        platforms: ["web"],
        audience: { type: "users", user_ids: [alice.id, bob.id] },
        title: "New studios in Mumbai",
        body: "Twelve new studios just went live.",
        link_url: "https://prodbnb.test/collections/mumbai",
        email_subject: "New studios in Mumbai",
        email_body: "Hi!\n\nTwelve **new studios** just went live. [See them](https://prodbnb.test/collections/mumbai).",
        ...body,
      });
    if (res.status === 201) {
      campaignIds.push(res.body.data.id as string);
    }
    return res;
  }

  it("previews the audience before sending", async () => {
    const res = await request(app)
      .post("/v1/admin/campaigns/audience-preview")
      .set(auth(moderator))
      .send({ audience: { type: "users", user_ids: [alice.id, bob.id] }, platforms: ["web"] })
      .expect(200);
    expect(res.body.data).toMatchObject({ users: 2, with_email: 2, devices: { web: 1, ios: 0, android: 0 } });
  });

  it("delivers an announcement over in-app, push and email, with honest per-recipient outcomes", async () => {
    await createCampaign(finance, {}).then((r) => expect(r.status).toBe(403));
    const created = await createCampaign(support, {});
    expect(created.status).toBe(201);
    // Push implies in-app.
    expect(created.body.data.channels).toEqual(["in_app", "push", "email"]);
    const id = created.body.data.id as string;

    mail.sent.length = 0;
    pushes.sent.length = 0;
    const sent = await request(app).post(`/v1/admin/campaigns/${id}/send`).set(auth(support)).send({}).expect(200);
    expect(sent.body.data.status).toBe("sent");
    expect(sent.body.data.stats).toMatchObject({
      total: 2,
      processed: 2,
      in_app_created: 2,
      push_sent: 1,
      push_no_devices: 1,
      email_sent: 2,
    });

    expect(pushes.sent).toHaveLength(1);
    expect(JSON.parse(pushes.sent[0].payload)).toMatchObject({
      title: "New studios in Mumbai",
      data: { prodbnb_type: "announcement", prodbnb_campaign_id: id, prodbnb_link_url: "https://prodbnb.test/collections/mumbai" },
    });

    expect(mail.sent.map((m) => m.to).sort()).toEqual([alice.email, bob.email].sort());
    const aliceMail = mail.sent.find((m) => m.to === alice.email)!;
    expect(aliceMail.html).toContain("<strong>new studios</strong>");
    expect(aliceMail.html).toContain('href="https://prodbnb.test/collections/mumbai"');
    expect(aliceMail.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    // In-app: hidden from today's iOS build, shown to a client that opts in.
    const legacy = await request(app).get("/v1/notifications").set(auth(alice)).expect(200);
    expect(legacy.body.data.find((n: { type: string }) => n.type === "announcement")).toBeUndefined();
    const modern = await request(app)
      .get("/v1/notifications")
      .set(auth(alice))
      .set("X-ProdBnb-Capabilities", "announcements")
      .expect(200);
    expect(modern.body.data.find((n: { type: string }) => n.type === "announcement")).toMatchObject({
      entity_type: "announcement",
      entity_id: id,
      title: "New studios in Mumbai",
    });

    const recipients = await request(app).get(`/v1/admin/campaigns/${id}/recipients`).set(auth(moderator)).expect(200);
    const bobRow = recipients.body.data.find((r: { user_id: string }) => r.user_id === bob.id);
    expect(bobRow).toMatchObject({ push_status: "no_devices", email_status: "sent", in_app_status: "created" });

    // A sent campaign cannot be edited or re-sent.
    await request(app).patch(`/v1/admin/campaigns/${id}`).set(auth(support)).send({ title: "x" }).expect(400);
    await request(app).post(`/v1/admin/campaigns/${id}/send`).set(auth(support)).send({}).expect(400);
  });

  it("honours one-click unsubscribe for announcements but not for direct messages", async () => {
    const link = mail.sent.find((m) => m.to === alice.email)!.headers!["List-Unsubscribe"].slice(1, -1);
    const path = link.replace(/^https?:\/\/[^/]+/, "");
    // GET only shows a confirmation -- scanners prefetch links.
    const page = await request(app).get(path).expect(200);
    expect(page.text).toContain("<form method=\"post\"");
    const { data: before } = await adminClient.from("email_suppressions").select("email").eq("email", alice.email.toLowerCase());
    expect(before).toHaveLength(0);
    await request(app).post(path).type("form").send("List-Unsubscribe=One-Click").expect(200);
    await request(app).get("/v1/email/unsubscribe?token=forged.token123").expect(400);

    const again = await createCampaign(support, { channels: ["email"], audience: { type: "users", user_ids: [alice.id] } });
    const sent = await request(app).post(`/v1/admin/campaigns/${again.body.data.id}/send`).set(auth(support)).send({}).expect(200);
    expect(sent.body.data.stats).toMatchObject({ email_unsubscribed: 1, email_sent: 0 });

    mail.sent.length = 0;
    const direct = await createCampaign(support, {
      kind: "direct",
      channels: ["email"],
      audience: { type: "users", user_ids: [alice.id] },
      email_subject: "About your listing",
    });
    const sentDirect = await request(app).post(`/v1/admin/campaigns/${direct.body.data.id}/send`).set(auth(support)).send({}).expect(200);
    expect(sentDirect.body.data.stats.email_sent).toBe(1);
    expect(mail.sent[0].headers?.["List-Unsubscribe"]).toBeUndefined();
  });

  it("respects the announcement push preference", async () => {
    await request(app).patch("/v1/notification-preferences").set(auth(alice)).send({ announcement: false }).expect(200);
    const c = await createCampaign(support, { channels: ["push"], audience: { type: "users", user_ids: [alice.id] } });
    const sent = await request(app).post(`/v1/admin/campaigns/${c.body.data.id}/send`).set(auth(support)).send({}).expect(200);
    expect(sent.body.data.stats).toMatchObject({ push_opted_out: 1, push_sent: 0, in_app_created: 1 });
    await request(app).patch("/v1/notification-preferences").set(auth(alice)).send({ announcement: true }).expect(200);
  });

  it("schedules a campaign and lets the secret-protected dispatcher send it when due", async () => {
    const c = await createCampaign(support, { channels: ["in_app"], audience: { type: "users", user_ids: [bob.id] } });
    const id = c.body.data.id as string;
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = await request(app).post(`/v1/admin/campaigns/${id}/send`).set(auth(support)).send({ scheduled_at: future }).expect(200);
    expect(scheduled.body.data.status).toBe("scheduled");

    await request(app).post("/v1/internal/jobs/dispatch").set("X-ProdBnb-Job-Secret", "nope").expect(401);
    await adminClient.from("notification_campaigns").update({ scheduled_at: new Date(Date.now() - 1000).toISOString() }).eq("id", id);
    const { data: secret } = await adminClient.rpc("system_secret", { _name: "prodbnb_jobs_secret" });
    const run = await request(app).post("/v1/internal/jobs/dispatch").set("X-ProdBnb-Job-Secret", secret as string).expect(200);
    expect(run.body.data.started).toBeGreaterThanOrEqual(1);

    const after = await request(app).get(`/v1/admin/campaigns/${id}`).set(auth(support)).expect(200);
    expect(after.body.data).toMatchObject({ status: "sent", stats: { in_app_created: 1 } });
    const { data: cfg } = await adminClient.from("background_jobs_config").select("last_run_ok").eq("singleton", true).single();
    expect(cfg?.last_run_ok).toBe(true);
  });

  it("cancels a scheduled campaign and deletes drafts only", async () => {
    const c = await createCampaign(support, { channels: ["in_app"], audience: { type: "users", user_ids: [bob.id] } });
    const id = c.body.data.id as string;
    await request(app)
      .post(`/v1/admin/campaigns/${id}/send`)
      .set(auth(support))
      .send({ scheduled_at: new Date(Date.now() + 7_200_000).toISOString() })
      .expect(200);
    await request(app).delete(`/v1/admin/campaigns/${id}`).set(auth(support)).expect(400);
    const cancelled = await request(app).post(`/v1/admin/campaigns/${id}/cancel`).set(auth(support)).expect(200);
    expect(cancelled.body.data.status).toBe("cancelled");

    const draft = await createCampaign(support, { channels: ["in_app"], audience: { type: "users", user_ids: [bob.id] } });
    await request(app).delete(`/v1/admin/campaigns/${draft.body.data.id}`).set(auth(support)).expect(200);
  });

  it("sends a test to the admin themself only", async () => {
    mail.sent.length = 0;
    const res = await request(app)
      .post("/v1/admin/campaigns/test")
      .set(auth(support))
      .send({ channels: ["email"], title: "T", body: "B", email_subject: "Subject", email_body: "Hello" })
      .expect(200);
    expect(res.body.data.email.ok).toBe(true);
    expect(mail.sent.map((m) => m.to)).toEqual([support.email]);
    expect(mail.sent[0].subject).toBe("[Test] Subject");
  });

  it("reports background-job health and refuses email when SMTP is not connected", async () => {
    const jobs = await request(app).get("/v1/admin/messaging/jobs").set(auth(support)).expect(200);
    expect(jobs.body.data.health).toMatchObject({ pg_cron: true, dispatch_job_scheduled: true });
    expect(jobs.body.data.suggested_url).toMatch(/\/v1\/internal\/jobs\/dispatch$/);
    await request(app).put("/v1/admin/messaging/jobs").set(auth(support)).send({ enabled: true }).expect(403);
    const updated = await request(app)
      .put("/v1/admin/messaging/jobs")
      .set(auth(superAdmin))
      .send({ enabled: true, dispatch_url: "https://api.prodbnb.test/v1/internal/jobs/dispatch" })
      .expect(200);
    expect(updated.body.data).toMatchObject({ enabled: true, dispatch_url: "https://api.prodbnb.test/v1/internal/jobs/dispatch" });

    await request(app).delete("/v1/admin/messaging/channels/smtp").set(auth(superAdmin)).expect(200);
    const c = await createCampaign(support, { channels: ["email"], audience: { type: "users", user_ids: [bob.id] } });
    await request(app).post(`/v1/admin/campaigns/${c.body.data.id}/send`).set(auth(support)).send({}).expect(400);
  });
});

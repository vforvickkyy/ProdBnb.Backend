import { randomUUID } from "crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { compareVersions, resetReleaseCachesForTesting } from "../src/modules/platform/releases.service";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

const app = createApp();

function auth(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${user.accessToken}` };
}

async function makeAdmin(user: TestUser, teamRole: "super_admin" | "support" | "finance"): Promise<void> {
  const { error } = await adminClient.from("user_roles").insert({ user_id: user.id, role: "admin" });
  if (error) throw error;
  if (teamRole !== "super_admin") {
    const { error: roleError } = await adminClient.from("admin_team_members").update({ team_role: teamRole }).eq("user_id", user.id);
    if (roleError) throw roleError;
  }
}

describe("Admin Console 2: platforms, feature flags, incidents, releases, /v1/app-config", () => {
  let superAdmin: TestUser;
  let support: TestUser;
  let finance: TestUser;
  let appUser: TestUser;
  let originalIos: Record<string, unknown>;
  const flagKey = `test_flag_${randomUUID().slice(0, 6)}`;
  const created = { flags: [] as string[], incidents: [] as string[], releases: [] as string[] };

  beforeAll(async () => {
    [superAdmin, support, finance, appUser] = await Promise.all([createTestUser(), createTestUser(), createTestUser(), createTestUser()]);
    await makeAdmin(superAdmin, "super_admin");
    await makeAdmin(support, "support");
    await makeAdmin(finance, "finance");
    const { data } = await adminClient.from("app_platforms").select("*").eq("platform", "ios").single();
    originalIos = data as Record<string, unknown>;
  });

  afterAll(async () => {
    const { id: _id, platform: _p, created_at: _c, updated_at: _u, ...restore } = originalIos;
    await adminClient.from("app_platforms").update(restore).eq("platform", "ios");
    if (created.flags.length) await adminClient.from("feature_flags").delete().in("id", created.flags);
    if (created.incidents.length) await adminClient.from("platform_incidents").delete().in("id", created.incidents);
    if (created.releases.length) await adminClient.from("release_plans").delete().in("id", created.releases);
    resetReleaseCachesForTesting();
    for (const user of [superAdmin, support, finance, appUser]) {
      await deleteTestUser(user.id);
    }
  });

  it("compares dotted versions numerically", () => {
    expect(compareVersions("1.10.0", "1.9")).toBe(1);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("2.0", "10.0")).toBe(-1);
  });

  it("lists the seeded platforms to every admin, edits them only as super admin", async () => {
    const overview = await request(app).get("/v1/admin/platforms").set(auth(finance)).expect(200);
    expect(overview.body.data.platforms.map((p: { platform: string }) => p.platform)).toEqual(["android", "ios", "web"]);
    expect(overview.body.data.health.active_devices).toHaveProperty("ios");

    await request(app).patch("/v1/admin/platforms/ios").set(auth(support)).send({ status: "live" }).expect(403);
    await request(app)
      .patch("/v1/admin/platforms/ios")
      .set(auth(superAdmin))
      .send({ latest_version: "1.0.0", min_supported_version: "2.0.0" })
      .expect(400);
    const res = await request(app)
      .patch("/v1/admin/platforms/ios")
      .set(auth(superAdmin))
      .send({
        status: "live",
        live_version: "1.4.0",
        latest_version: "1.5.0",
        min_supported_version: "1.2.0",
        store_url: "https://apps.apple.com/app/id000000",
        update_message: "A new version is available.",
        force_update_message: "Please update to keep using ProdBnb.",
      })
      .expect(200);
    expect(res.body.data).toMatchObject({ status: "live", live_version: "1.4.0" });
    const { data: audit } = await adminClient
      .from("admin_audit_log")
      .select("metadata")
      .eq("action", "ADMIN_UPDATED_PLATFORM")
      .eq("admin_id", superAdmin.id);
    expect(audit?.length).toBeGreaterThan(0);
  });

  it("serves update prompts by version through /v1/app-config", async () => {
    resetReleaseCachesForTesting();
    const old = await request(app).get("/v1/app-config").query({ platform: "ios", version: "1.1.0" }).expect(200);
    expect(old.headers["cache-control"]).toBe("public, max-age=30");
    expect(old.body.data.update).toMatchObject({ required: true, available: true, message: "Please update to keep using ProdBnb." });

    const mid = await request(app).get("/v1/app-config").query({ platform: "ios", version: "1.4.0" }).expect(200);
    expect(mid.body.data.update).toMatchObject({ required: false, available: true, message: "A new version is available." });

    const current = await request(app).get("/v1/app-config").query({ platform: "ios", version: "1.5.0" }).expect(200);
    expect(current.body.data.update).toMatchObject({ required: false, available: false, message: null });

    await request(app).get("/v1/app-config").query({ platform: "windows" }).expect(400);
  });

  it("evaluates feature flags per platform and minimum version", async () => {
    await request(app)
      .post("/v1/admin/feature-flags")
      .set(auth(superAdmin))
      .send({ key: "Bad Key", name: "x" })
      .expect(400);
    const flag = await request(app)
      .post("/v1/admin/feature-flags")
      .set(auth(superAdmin))
      .send({
        key: flagKey,
        name: "Collections on home",
        targets: { ios: { enabled: true, min_version: "1.5.0" }, android: { enabled: false } },
      })
      .expect(201);
    created.flags.push(flag.body.data.id);
    await request(app).post("/v1/admin/feature-flags").set(auth(superAdmin)).send({ key: flagKey, name: "dup" }).expect(409);

    const onOld = await request(app).get("/v1/app-config").query({ platform: "ios", version: "1.4.9" }).expect(200);
    expect(onOld.body.data.features[flagKey]).toBe(false);
    const onNew = await request(app).get("/v1/app-config").query({ platform: "ios", version: "1.5.0" }).expect(200);
    expect(onNew.body.data.features[flagKey]).toBe(true);
    const noVersion = await request(app).get("/v1/app-config").query({ platform: "ios" }).expect(200);
    expect(noVersion.body.data.features[flagKey]).toBe(false);
    const android = await request(app).get("/v1/app-config").query({ platform: "android", version: "9.9" }).expect(200);
    expect(android.body.data.features[flagKey]).toBe(false);

    await request(app)
      .patch(`/v1/admin/feature-flags/${flag.body.data.id}`)
      .set(auth(superAdmin))
      .send({ targets: { android: { enabled: true } } })
      .expect(200);
    const androidOn = await request(app).get("/v1/app-config").query({ platform: "android", version: "1.0" }).expect(200);
    expect(androidOn.body.data.features[flagKey]).toBe(true);
  });

  it("publishes open public incidents to the affected platform only, with a timeline", async () => {
    await request(app).post("/v1/admin/incidents").set(auth(finance)).send({ title: "x", platforms: ["ios"] }).expect(403);
    const incident = await request(app)
      .post("/v1/admin/incidents")
      .set(auth(support))
      .send({
        title: "Payments delayed",
        summary: "Some payments take longer to confirm.",
        severity: "major",
        platforms: ["ios", "backend"],
        is_public: true,
        message: "Investigating reports from hosts.",
      })
      .expect(201);
    const id = incident.body.data.id as string;
    created.incidents.push(id);

    const ios = await request(app).get("/v1/app-config").query({ platform: "ios", version: "1.5.0" }).expect(200);
    expect(ios.body.data.incidents.map((i: { id: string }) => i.id)).toContain(id);
    const web = await request(app).get("/v1/app-config").query({ platform: "web" }).expect(200);
    expect(web.body.data.incidents.map((i: { id: string }) => i.id)).not.toContain(id);

    await request(app).patch(`/v1/admin/incidents/${id}`).set(auth(support)).send({ status: "resolved", message: "Fixed." }).expect(200);
    const after = await request(app).get("/v1/app-config").query({ platform: "ios", version: "1.5.0" }).expect(200);
    expect(after.body.data.incidents.map((i: { id: string }) => i.id)).not.toContain(id);

    const overview = await request(app).get("/v1/admin/platforms").set(auth(support)).expect(200);
    const listed = overview.body.data.incidents.find((i: { id: string }) => i.id === id);
    expect(listed.resolved_at).not.toBeNull();
    expect(listed.updates.map((u: { message: string }) => u.message)).toEqual(["Investigating reports from hosts.", "Fixed."]);
  });

  it("plans releases and promotes a released version to live", async () => {
    const release = await request(app)
      .post("/v1/admin/releases")
      .set(auth(superAdmin))
      .send({ platform: "ios", version: "1.6.0", title: "Collections", target_date: "2026-12-01", feature_keys: [flagKey] })
      .expect(201);
    created.releases.push(release.body.data.id);
    expect(release.body.data.status).toBe("planned");

    await request(app)
      .patch(`/v1/admin/releases/${release.body.data.id}`)
      .set(auth(superAdmin))
      .send({ status: "released", promote_to_live: true })
      .expect(200);
    const { data: ios } = await adminClient.from("app_platforms").select("live_version, latest_version").eq("platform", "ios").single();
    expect(ios).toEqual({ live_version: "1.6.0", latest_version: "1.6.0" });

    await request(app).delete(`/v1/admin/releases/${release.body.data.id}`).set(auth(support)).expect(403);
  });

  it("counts which app versions signed-in clients are running", async () => {
    await request(app)
      .get("/v1/me")
      .set(auth(appUser))
      .set("X-ProdBnb-Platform", "android")
      .set("X-ProdBnb-App-Version", "0.9.1")
      .expect(200);
    // Fire-and-forget write -- give it a moment.
    let found = false;
    for (let i = 0; i < 20 && !found; i += 1) {
      const { data } = await adminClient.from("client_version_activity").select("app_version").eq("user_id", appUser.id);
      found = (data ?? []).some((r) => r.app_version === "0.9.1");
      if (!found) await new Promise((r) => setTimeout(r, 50));
    }
    expect(found).toBe(true);
    const overview = await request(app).get("/v1/admin/platforms").set(auth(finance)).expect(200);
    expect(
      overview.body.data.versions_in_use.find((v: { platform: string; app_version: string }) => v.platform === "android" && v.app_version === "0.9.1")
    ).toMatchObject({ users: expect.any(Number) });
  });
});

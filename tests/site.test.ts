import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { resetPlatformSettingsCacheForTesting } from "../src/modules/platform/settings.service";
import { describeDomain } from "../src/modules/site/domains.service";
import { clearSiteConfigCache } from "../src/modules/site/integrations.service";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

const app = createApp();
const BROWSER_KEY = "AIzaSyA1234567890abcdefghijklmnopqrstuv";
const SERVER_KEY = "AIzaSyZ0987654321zyxwvutsrqponmlkjihgfe";

function auth(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${user.accessToken}` };
}

async function makeAdmin(user: TestUser, teamRole: "super_admin" | "support"): Promise<void> {
  const { error } = await adminClient.from("user_roles").insert({ user_id: user.id, role: "admin" });
  if (error) throw error;
  if (teamRole !== "super_admin") {
    const { error: roleError } = await adminClient.from("admin_team_members").update({ team_role: teamRole }).eq("user_id", user.id);
    if (roleError) throw roleError;
  }
}

/** The fake project's domains -- shared by every test, like a real project's would be. */
const domains = new Map<string, Record<string, unknown>>([
  ["web-staging.vercel.app", { name: "web-staging.vercel.app", apexName: "vercel.app", verified: true, redirect: null, redirectStatusCode: null, gitBranch: null }],
]);

/** Answers Vercel API calls from a small in-memory project; everything else goes to the network. */
function fakeVercel() {
  const realFetch = globalThis.fetch;
  const calls: { method: string; path: string; body: unknown }[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "api.vercel.com") return realFetch(input, init);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    if ((init?.headers as Record<string, string>)?.Authorization !== "Bearer vercel-token-0123456789abcdef") {
      return json(403, { error: { code: "forbidden", message: "Not authorized" } });
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (method === "GET" && parts.length === 3 && parts[1] === "projects") return json(200, { id: "prj_web", name: "web-staging", framework: "nextjs" });
    if (method === "GET" && parts[3] === "domains" && parts.length === 4) return json(200, { domains: [...domains.values()] });
    if (method === "POST" && parts[3] === "domains" && parts.length === 4) {
      const name = body.name as string;
      const apexName = name.split(".").slice(-2).join(".");
      const domain = {
        name,
        apexName,
        verified: name !== "pending.example.com",
        redirect: body.redirect ?? null,
        redirectStatusCode: body.redirectStatusCode ?? null,
        gitBranch: null,
        verification: name === "pending.example.com" ? [{ type: "TXT", domain: "_vercel.example.com", value: "vc-domain-verify=abc", reason: "pending_domain_verification" }] : undefined,
      };
      domains.set(name, domain);
      return json(200, domain);
    }
    if (method === "PATCH" && parts[3] === "domains") {
      const domain = { ...domains.get(parts[4]!)!, redirect: body.redirect, redirectStatusCode: body.redirectStatusCode };
      domains.set(parts[4]!, domain);
      return json(200, domain);
    }
    if (method === "DELETE" && parts[3] === "domains") {
      domains.delete(parts[4]!);
      return json(200, {});
    }
    if (method === "GET" && parts[1] === "domains" && parts[3] === "config") {
      const name = decodeURIComponent(parts[2]!);
      const misconfigured = name.startsWith("new.");
      return json(200, {
        configuredBy: misconfigured ? null : "A",
        misconfigured,
        recommendedIPv4: [{ rank: 1, value: ["76.76.21.21"] }],
        recommendedCNAME: [{ rank: 1, value: "cname.vercel-dns-017.com." }],
        acceptedChallenges: [],
      });
    }
    return json(404, { error: { message: "unhandled in fake" } });
  });
  return { spy, calls };
}

describe("Website (Console 3)", () => {
  let superAdmin: TestUser;
  let support: TestUser;
  let booker: TestUser;
  let host: TestUser;
  let locationId: string;

  beforeAll(async () => {
    [superAdmin, support, booker, host] = await Promise.all([createTestUser(), createTestUser(), createTestUser(), createTestUser()]);
    await makeAdmin(superAdmin, "super_admin");
    await makeAdmin(support, "support");
    await request(app).post("/v1/me/roles").set(auth(host)).send({ role: "host" }).expect(201);
    const res = await request(app).post("/v1/locations").set(auth(host)).send({ title: "Site Test Location", city: "Mumbai", country: "India", timezone: "Asia/Kolkata" });
    locationId = res.body.data.id;
    await adminClient.from("locations").update({ status: "published" }).eq("id", locationId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await adminClient.rpc("site_integration_remove", { _provider: "google_maps" });
    await adminClient.rpc("site_integration_remove", { _provider: "vercel" });
    await adminClient.from("site_settings").update({ primary_domain: null }).eq("singleton", true);
    await adminClient.from("platform_settings").update({ availability_requires_login: true }).eq("singleton", true);
    resetPlatformSettingsCacheForTesting();
    clearSiteConfigCache();
    await adminClient.from("locations").delete().eq("id", locationId);
    for (const user of [superAdmin, support, booker, host]) await deleteTestUser(user.id);
  });

  describe("login to check availability", () => {
    it("answers signed-in people only, with a reason a client can act on", async () => {
      resetPlatformSettingsCacheForTesting();
      const anonymous = await request(app).get(`/v1/locations/${locationId}/availability`).query({ from: "2026-12-07", to: "2026-12-07" });
      expect(anonymous.status).toBe(401);
      expect(anonymous.body.error).toMatchObject({ code: "UNAUTHENTICATED", message: "Log in to check availability." });
      expect(anonymous.body.error.details).toEqual({ reason: "login_required_for_availability" });

      await request(app).get(`/v1/locations/${locationId}/availability`).set(auth(booker)).query({ from: "2026-12-07", to: "2026-12-07" }).expect(200);
    });

    it("is an admin switch: a super admin can open availability to everyone again, and it is audited", async () => {
      await request(app).patch("/v1/admin/settings").set(auth(support)).send({ availability_requires_login: false }).expect(403);
      const res = await request(app).patch("/v1/admin/settings").set(auth(superAdmin)).send({ availability_requires_login: false, reason: "Until the iOS update ships" });
      expect(res.status).toBe(200);
      expect(res.body.data.availability_requires_login).toBe(false);
      await request(app).get(`/v1/locations/${locationId}/availability`).query({ from: "2026-12-07", to: "2026-12-07" }).expect(200);

      const { data: audit } = await adminClient
        .from("admin_audit_log")
        .select("metadata, reason")
        .eq("admin_id", superAdmin.id)
        .eq("action", "ADMIN_UPDATED_SETTINGS")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      expect(audit!.metadata).toMatchObject({ changes: { availability_requires_login: { from: true, to: false } } });

      const config = await request(app).get("/v1/site-config").expect(200);
      expect(config.body.data.features.availability_requires_login).toBe(false);

      await request(app).patch("/v1/admin/settings").set(auth(superAdmin)).send({ availability_requires_login: true }).expect(200);
      await request(app).get(`/v1/locations/${locationId}/availability`).query({ from: "2026-12-07", to: "2026-12-07" }).expect(401);
    });
  });

  describe("Google Maps", () => {
    it("rejects something that is not a Maps key, and only a super admin can save", async () => {
      await request(app).put("/v1/admin/site/integrations/google_maps").set(auth(superAdmin)).send({ browser_key: "not-a-key" }).expect(400);
      await request(app).put("/v1/admin/site/integrations/google_maps").set(auth(support)).send({ browser_key: BROWSER_KEY }).expect(403);
    });

    it("publishes the browser key to the website, never the server key", async () => {
      const before = await request(app).get("/v1/site-config").expect(200);
      expect(before.body.data.maps).toBeNull();

      const saved = await request(app)
        .put("/v1/admin/site/integrations/google_maps")
        .set(auth(superAdmin))
        .send({ browser_key: BROWSER_KEY, map_id: "abc123mapid", server_key: SERVER_KEY });
      expect(saved.status).toBe(200);
      expect(saved.body.data).toMatchObject({ provider: "google_maps", connected: true, has_secret: true });
      expect(saved.body.data.config).toEqual({ browser_key_preview: `${BROWSER_KEY.slice(0, 6)}…${BROWSER_KEY.slice(-4)}`, map_id: "abc123mapid" });
      expect(JSON.stringify(saved.body)).not.toContain(SERVER_KEY);

      const config = await request(app).get("/v1/site-config").expect(200);
      expect(config.headers["cache-control"]).toContain("max-age=60");
      expect(config.body.data.maps).toEqual({ provider: "google", browser_key: BROWSER_KEY, map_id: "abc123mapid" });
      expect(JSON.stringify(config.body)).not.toContain(SERVER_KEY);

      // Every admin can see the status; nobody gets a secret back.
      const list = await request(app).get("/v1/admin/site/integrations").set(auth(support)).expect(200);
      expect(JSON.stringify(list.body)).not.toContain(SERVER_KEY);
      expect(JSON.stringify(list.body)).not.toContain(BROWSER_KEY);

      const { data: audit } = await adminClient.from("admin_audit_log").select("target_type, metadata").eq("action", "ADMIN_CONNECTED_SITE_INTEGRATION").eq("admin_id", superAdmin.id).limit(1).single();
      expect(audit).toMatchObject({ target_type: "site_integration", metadata: { provider: "google_maps", server_key_replaced: true } });
    });

    it("keeps the stored server key and map id when only the browser key changes", async () => {
      const newKey = BROWSER_KEY.replace("A123", "B123");
      const saved = await request(app).put("/v1/admin/site/integrations/google_maps").set(auth(superAdmin)).send({ browser_key: newKey });
      expect(saved.body.data).toMatchObject({ has_secret: true, config: { map_id: "abc123mapid" } });
      const { data } = await adminClient.rpc("site_integration_secret", { _provider: "google_maps" });
      expect(data).toBe(SERVER_KEY);
    });

    it("disconnecting removes the key from the website and the secret from Vault", async () => {
      await request(app).delete("/v1/admin/site/integrations/google_maps").set(auth(superAdmin)).expect(200);
      const config = await request(app).get("/v1/site-config").expect(200);
      expect(config.body.data.maps).toBeNull();
      const { data } = await adminClient.from("site_integrations").select("id").eq("provider", "google_maps");
      expect(data).toEqual([]);
    });
  });

  describe("domains (through the website's Vercel project)", () => {
    it("says Vercel is not connected yet instead of failing", async () => {
      const res = await request(app).get("/v1/admin/site/domains").set(auth(support)).expect(200);
      expect(res.body.data).toEqual({ vercel_connected: false, primary_domain: null, domains: [] });
    });

    it("checks the token can see the project before storing it", async () => {
      fakeVercel();
      await request(app)
        .put("/v1/admin/site/integrations/vercel")
        .set(auth(superAdmin))
        .send({ project_id: "prj_web", token: "wrong-token-0123456789abcdef" })
        .expect(400);
      const saved = await request(app)
        .put("/v1/admin/site/integrations/vercel")
        .set(auth(superAdmin))
        .send({ project_id: "prj_web", team_id: "team_x", token: "vercel-token-0123456789abcdef" });
      expect(saved.status).toBe(200);
      expect(saved.body.data).toMatchObject({ connected: true, has_secret: true, config: { project_id: "prj_web", project_name: "web-staging", team_id: "team_x" } });
      expect(JSON.stringify(saved.body)).not.toContain("vercel-token");
    });

    it("adds a domain and tells the admin exactly which DNS records to create", async () => {
      const { calls } = fakeVercel();
      const added = await request(app).post("/v1/admin/site/domains").set(auth(superAdmin)).send({ name: "New.Example.com" });
      expect(added.status).toBe(201);
      expect(added.body.data).toMatchObject({
        name: "new.example.com",
        is_apex: false,
        verified: true,
        configured: false,
        status: "pending_dns",
        dns_records: [{ type: "CNAME", name: "new", value: "cname.vercel-dns-017.com", purpose: "point" }],
      });
      expect(calls.find((c) => c.method === "POST")?.path).toBe("/v10/projects/prj_web/domains");

      const pending = await request(app).post("/v1/admin/site/domains").set(auth(superAdmin)).send({ name: "pending.example.com" });
      expect(pending.body.data.dns_records).toContainEqual({ type: "TXT", name: "_vercel", value: "vc-domain-verify=abc", purpose: "verify" });
      expect(pending.body.data.status).toBe("pending_verification");

      await request(app).post("/v1/admin/site/domains").set(auth(support)).send({ name: "x.example.com" }).expect(403);
    });

    it("only makes a fully set-up domain primary, and the website then uses it", async () => {
      fakeVercel();
      await request(app).post("/v1/admin/site/domains").set(auth(superAdmin)).send({ name: "example.com" }).expect(201);
      await request(app).put("/v1/admin/site/primary-domain").set(auth(superAdmin)).send({ domain: "new.example.com" }).expect(409);

      const res = await request(app).put("/v1/admin/site/primary-domain").set(auth(superAdmin)).send({ domain: "example.com" });
      expect(res.status).toBe(200);
      expect(res.body.data.primary_domain).toBe("example.com");
      expect(res.body.data.domains[0]).toMatchObject({ name: "example.com", is_primary: true, status: "active" });

      const config = await request(app).get("/v1/site-config").expect(200);
      expect(config.body.data.site).toMatchObject({ primary_domain: "example.com", url: "https://example.com" });

      // The website on its primary domain can call the API from the browser with no redeploy...
      const allowed = await request(app).get("/v1/site-config").set("Origin", "https://example.com");
      expect(allowed.headers["access-control-allow-origin"]).toBe("https://example.com");
      // ...and nothing else gets in by that route.
      const other = await request(app).get("/v1/site-config").set("Origin", "https://evil.example.org");
      expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("protects the primary domain and the platform address from removal; redirects others", async () => {
      fakeVercel();
      await request(app).delete("/v1/admin/site/domains/example.com").set(auth(superAdmin)).expect(409);
      await request(app).delete("/v1/admin/site/domains/web-staging.vercel.app").set(auth(superAdmin)).expect(400);
      await request(app).patch("/v1/admin/site/domains/example.com").set(auth(superAdmin)).send({ redirect_to: "new.example.com" }).expect(409);

      await request(app).post("/v1/admin/site/domains").set(auth(superAdmin)).send({ name: "www.example.com" }).expect(201);
      const redirected = await request(app).patch("/v1/admin/site/domains/www.example.com").set(auth(superAdmin)).send({ redirect_to: "example.com" });
      expect(redirected.body.data).toMatchObject({ redirect_to: "example.com", status: "redirect" });

      await request(app).delete("/v1/admin/site/domains/www.example.com").set(auth(superAdmin)).expect(200);
      const { data: audit } = await adminClient.from("admin_audit_log").select("action").eq("admin_id", superAdmin.id).eq("target_type", "site");
      expect((audit ?? []).map((a) => a.action)).toEqual(expect.arrayContaining(["ADMIN_ADDED_DOMAIN", "ADMIN_UPDATED_DOMAIN", "ADMIN_REMOVED_DOMAIN", "ADMIN_SET_PRIMARY_DOMAIN"]));
    });
  });

  describe("describeDomain", () => {
    const config = { configuredBy: null, misconfigured: true, recommendedIPv4: [{ rank: 2, value: ["1.1.1.1"] }, { rank: 1, value: ["76.76.21.21"] }], recommendedCNAME: [] };

    it("asks for an A record at the bare domain, using Vercel's top-ranked address", () => {
      const domain = describeDomain({ name: "example.in", apexName: "example.in", verified: true, redirect: null, redirectStatusCode: null, gitBranch: null }, config, null);
      expect(domain.dns_records).toEqual([{ type: "A", name: "@", value: "76.76.21.21", purpose: "point" }]);
      expect(domain).toMatchObject({ is_apex: true, status: "pending_dns" });
    });

    it("needs nothing for the platform's own address", () => {
      const domain = describeDomain({ name: "site.vercel.app", apexName: "vercel.app", verified: true, redirect: null, redirectStatusCode: null, gitBranch: null }, null, null);
      expect(domain).toMatchObject({ is_platform_domain: true, configured: true, status: "active", dns_records: [] });
    });
  });
});

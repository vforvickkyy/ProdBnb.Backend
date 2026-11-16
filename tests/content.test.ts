import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { findPlaceholders } from "../src/modules/content/pages.service";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

const app = createApp();

function auth(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${user.accessToken}` };
}

async function makeAdmin(user: TestUser, teamRole: "super_admin" | "moderator" | "support"): Promise<void> {
  const { error } = await adminClient.from("user_roles").insert({ user_id: user.id, role: "admin" });
  if (error) throw error;
  if (teamRole !== "super_admin") {
    const { error: roleError } = await adminClient.from("admin_team_members").update({ team_role: teamRole }).eq("user_id", user.id);
    if (roleError) throw roleError;
  }
}

describe("website pages and SEO", () => {
  let moderator: TestUser;
  let support: TestUser;
  let member: TestUser;
  let host: TestUser;
  const slug = `test-page-${Date.now()}`;
  let pageId: string;
  let locationId: string;

  beforeAll(async () => {
    moderator = await createTestUser();
    support = await createTestUser();
    member = await createTestUser();
    host = await createTestUser();
    await makeAdmin(moderator, "moderator");
    await makeAdmin(support, "support");
    expect((await request(app).post("/v1/me/roles").set(auth(host)).send({ role: "host" })).status).toBe(201);
    const res = await request(app).post("/v1/locations").set(auth(host)).send({ title: "SEO fixture", description: "", city: "Pune", country: "India" });
    expect(res.status).toBe(201);
    locationId = res.body.data.id;
  });

  afterAll(async () => {
    await adminClient.from("site_pages").delete().like("slug", "test-page-%");
    await adminClient.from("seo_overrides").delete().eq("entity_key", locationId);
    await adminClient.from("seo_overrides").delete().eq("entity_key", "home");
    for (const user of [moderator, support, member, host]) await deleteTestUser(user.id);
  });

  it("serves the seeded policy pages publicly, without their text in the list", async () => {
    const list = await request(app).get("/v1/site-pages");
    expect(list.status).toBe(200);
    const slugs = list.body.data.map((p: { slug: string }) => p.slug);
    expect(slugs).toEqual(expect.arrayContaining(["privacy", "terms", "refund-policy", "about", "contact", "grievance-redressal", "host-terms", "help"]));
    expect(list.body.data[0]).not.toHaveProperty("body");

    const privacy = await request(app).get("/v1/site-pages/privacy");
    expect(privacy.status).toBe(200);
    expect(privacy.body.data.body).toContain("{{brand}}");
    expect(privacy.body.data.title).toBe("Privacy policy");
  });

  it("finds bracketed placeholders but not Markdown links", () => {
    expect(findPlaceholders("Hi [Company legal name], see [terms](/terms) and [ ] or [x].")).toEqual(["[Company legal name]"]);
  });

  it("lets a moderator create, edit, publish and delete a page, with an audit trail", async () => {
    const createRes = await request(app)
      .post("/v1/admin/site/pages")
      .set(auth(moderator))
      .send({ slug, title: "Test page", body: "Hello [Your name]", placement: "company" });
    expect(createRes.status).toBe(201);
    pageId = createRes.body.data.id;
    expect(createRes.body.data.is_published).toBe(false);
    expect(createRes.body.data.placeholders).toEqual(["[Your name]"]);

    // Drafts are not public.
    expect((await request(app).get(`/v1/site-pages/${slug}`)).status).toBe(404);

    const publish = await request(app)
      .patch(`/v1/admin/site/pages/${pageId}`)
      .set(auth(moderator))
      .send({ is_published: true, body: "Hello world", needs_review: false, reason: "Ready" });
    expect(publish.status).toBe(200);
    expect(publish.body.data.placeholders).toEqual([]);
    const pub = await request(app).get(`/v1/site-pages/${slug}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.body).toBe("Hello world");

    const { data: audit } = await adminClient.from("admin_audit_log").select("action, reason, metadata").eq("target_id", pageId).order("created_at");
    expect((audit ?? []).map((a) => a.action)).toEqual(["ADMIN_CREATED_PAGE", "ADMIN_UPDATED_PAGE"]);
    expect(audit![1]!.reason).toBe("Ready");
    expect((audit![1]!.metadata as { changes: Record<string, unknown> }).changes).toHaveProperty("is_published");

    const del = await request(app).delete(`/v1/admin/site/pages/${pageId}`).set(auth(moderator));
    expect(del.status).toBe(200);
    expect((await request(app).get(`/v1/site-pages/${slug}`)).status).toBe(404);
  });

  it("refuses reserved and duplicate addresses", async () => {
    const reserved = await request(app).post("/v1/admin/site/pages").set(auth(moderator)).send({ slug: "search", title: "Nope" });
    expect(reserved.status).toBe(400);
    const dup = await request(app).post("/v1/admin/site/pages").set(auth(moderator)).send({ slug: "privacy", title: "Copy" });
    expect(dup.status).toBe(409);
  });

  it("lets support read pages but not change them; non-admins get nothing", async () => {
    expect((await request(app).get("/v1/admin/site/pages").set(auth(support))).status).toBe(200);
    const edit = await request(app).post("/v1/admin/site/pages").set(auth(support)).send({ slug: `${slug}-x`, title: "X" });
    expect(edit.status).toBe(403);
    expect((await request(app).get("/v1/admin/site/pages").set(auth(member))).status).toBe(403);
  });

  it("saves, serves and resets a listing's SEO override", async () => {
    expect((await request(app).get(`/v1/seo/location/${locationId}`)).body.data).toBeNull();

    const save = await request(app)
      .put(`/v1/admin/site/seo/location/${locationId}`)
      .set(auth(moderator))
      .send({ meta_title: "Sunlit loft for shoots in Mumbai", meta_description: "  ", noindex: true });
    expect(save.status).toBe(200);
    expect(save.body.data.meta_title).toBe("Sunlit loft for shoots in Mumbai");
    // Blank text means "automatic".
    expect(save.body.data.meta_description).toBeNull();

    const pub = await request(app).get(`/v1/seo/location/${locationId}`);
    expect(pub.body.data).toEqual({ meta_title: "Sunlit loft for shoots in Mumbai", meta_description: null, og_image_url: null, noindex: true });
    const noindex = await request(app).get("/v1/seo/noindex");
    expect(noindex.body.data).toEqual(expect.arrayContaining([{ entity_type: "location", entity_key: locationId }]));

    // Leaving out a field keeps it.
    const partial = await request(app).put(`/v1/admin/site/seo/location/${locationId}`).set(auth(moderator)).send({ meta_description: "Big windows." });
    expect(partial.body.data.meta_title).toBe("Sunlit loft for shoots in Mumbai");
    expect(partial.body.data.meta_description).toBe("Big windows.");

    // Emptying everything deletes the override.
    const reset = await request(app)
      .put(`/v1/admin/site/seo/location/${locationId}`)
      .set(auth(moderator))
      .send({ meta_title: null, meta_description: null, noindex: false });
    expect(reset.status).toBe(200);
    expect(reset.body.data).toBeNull();
    expect((await request(app).get(`/v1/seo/location/${locationId}`)).body.data).toBeNull();

    const { data: audit } = await adminClient
      .from("admin_audit_log")
      .select("action, metadata")
      .eq("action", "ADMIN_UPDATED_SEO")
      .eq("admin_id", moderator.id)
      .order("created_at");
    expect(audit).toHaveLength(3);
    expect((audit![2]!.metadata as { reset: boolean }).reset).toBe(true);
  });

  it("sets the website's contact email, serves it publicly and audits it", async () => {
    const { clearSiteConfigCache } = await import("../src/modules/site/integrations.service");
    const set = await request(app).put("/v1/admin/site/contact").set(auth(moderator)).send({ support_email: " Help@Example.in ", reason: "Launch" });
    expect(set.status).toBe(200);
    expect(set.body.data.support_email).toBe("help@example.in");
    clearSiteConfigCache();
    expect((await request(app).get("/v1/site-config")).body.data.site.support_email).toBe("help@example.in");
    expect((await request(app).put("/v1/admin/site/contact").set(auth(moderator)).send({ support_email: "not-an-email" })).status).toBe(400);
    expect((await request(app).put("/v1/admin/site/contact").set(auth(support)).send({ support_email: null })).status).toBe(403);
    const { data: audit } = await adminClient
      .from("admin_audit_log")
      .select("action, target_type, metadata")
      .eq("admin_id", moderator.id)
      .eq("action", "ADMIN_UPDATED_SETTINGS");
    expect(audit).toHaveLength(1);
    expect(audit![0]!.target_type).toBe("site");
    const cleared = await request(app).put("/v1/admin/site/contact").set(auth(moderator)).send({ support_email: "" });
    expect(cleared.body.data.support_email).toBeNull();
  });

  it("takes SEO for built-in pages, rejects unknown targets and bad images", async () => {
    const home = await request(app).put("/v1/admin/site/seo/page/home").set(auth(moderator)).send({ meta_description: "Find shoot locations." });
    expect(home.status).toBe(200);
    expect((await request(app).put("/v1/admin/site/seo/page/no-such-page").set(auth(moderator)).send({ noindex: true })).status).toBe(404);
    expect((await request(app).put("/v1/admin/site/seo/location/not-a-uuid").set(auth(moderator)).send({ noindex: true })).status).toBe(400);
    expect(
      (await request(app).put("/v1/admin/site/seo/collection/00000000-0000-4000-8000-000000000000").set(auth(moderator)).send({ noindex: true }))
        .status
    ).toBe(404);
    const insecure = await request(app).put("/v1/admin/site/seo/page/home").set(auth(moderator)).send({ og_image_url: "http://example.com/a.jpg" });
    expect(insecure.status).toBe(400);
    expect((await request(app).put("/v1/admin/site/seo/page/home").set(auth(support)).send({ noindex: true })).status).toBe(403);
  });
});

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

/**
 * Notification templates, {variables} filled in per person, the listing/offer a message is about,
 * segment audiences from onboarding answers, and the onboarding answers themselves.
 */
const app = createApp();
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.accessToken}` });

describe("notification templates, personalised sends and onboarding", () => {
  let support: TestUser;
  let finance: TestUser;
  let host: TestUser;
  let riya: TestUser;
  let arjun: TestUser;
  let nameless: TestUser;
  let locationId: string;
  let couponId: string;
  const city = `Testpur${Date.now() % 100000}`;
  const campaignIds: string[] = [];
  const templateIds: string[] = [];

  async function makeAdmin(user: TestUser, teamRole: "support" | "finance") {
    await adminClient.from("user_roles").insert({ user_id: user.id, role: "admin" });
    await adminClient.from("admin_team_members").update({ team_role: teamRole }).eq("user_id", user.id);
  }

  beforeAll(async () => {
    [support, finance, host, riya, arjun, nameless] = await Promise.all([createTestUser(), createTestUser(), createTestUser(), createTestUser(), createTestUser(), createTestUser()]);
    await makeAdmin(support, "support");
    await makeAdmin(finance, "finance");
    await request(app).post("/v1/me/roles").set(auth(host)).send({ role: "host" });
    await adminClient.from("profiles").update({ first_name: "Support" }).eq("id", support.id);
    await adminClient.from("profiles").update({ first_name: "Riya", last_name: "Menon", phone: "+91 98765 43210" }).eq("id", riya.id);
    await adminClient.from("profiles").update({ first_name: "Arjun", address_city: city }).eq("id", arjun.id);
    await adminClient.from("profiles").update({ first_name: null, last_name: null }).eq("id", nameless.id);
    const { error: prefError } = await adminClient.from("user_preferences").insert([
      { user_id: riya.id, professions: ["director"], cities: [city], new_listing_alerts: true },
      { user_id: arjun.id, professions: ["photographer"], cities: [], new_listing_alerts: false },
      { user_id: nameless.id, professions: ["director"], cities: [city.toUpperCase()], new_listing_alerts: true },
    ]);
    if (prefError) throw prefError;
    const loc = await request(app).post("/v1/locations").set(auth(host)).send({ title: "Rooftop with a view", city, country: "India", timezone: "Asia/Kolkata" });
    locationId = loc.body.data.id;
    await request(app).post(`/v1/locations/${locationId}/pricing`).set(auth(host)).send({ booking_type: "hourly", amount_minor_units: 250000 });
    const { data: coupon } = await adminClient
      .from("coupons")
      .insert({ code: `TPL${Date.now() % 1000000}`, owner_type: "platform", title: "Monsoon sale on all studios", discount_type: "percent", percent_off: 20, ends_at: "2026-12-31T18:29:59Z", created_by: finance.id })
      .select("id")
      .single();
    couponId = (coupon as { id: string }).id;
  });

  afterAll(async () => {
    if (campaignIds.length) {
      await adminClient.from("notifications").delete().in("entity_id", campaignIds);
      await adminClient.from("notification_campaigns").delete().in("id", campaignIds);
    }
    if (templateIds.length) await adminClient.from("notification_templates").delete().in("id", templateIds);
    await adminClient.from("coupons").delete().eq("id", couponId);
    await adminClient.from("locations").delete().eq("id", locationId);
    for (const u of [support, finance, host, riya, arjun, nameless]) await deleteTestUser(u.id).catch(() => undefined);
  });

  it("lists built-in templates and the variables, and refuses typos and missing context", async () => {
    expect((await request(app).get("/v1/admin/notification-templates").set(auth(finance))).status).toBe(403);
    const list = await request(app).get("/v1/admin/notification-templates").set(auth(support));
    expect(list.status).toBe(200);
    const names = list.body.data.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["New listing", "New offer", "Casual hello"]));
    expect(list.body.data.find((t: { name: string }) => t.name === "New listing")).toMatchObject({ needs: "listing", is_builtin: true });

    const vars = await request(app).get("/v1/admin/notification-variables").set(auth(support));
    expect(vars.body.data.map((v: { key: string }) => v.key)).toEqual(expect.arrayContaining(["first_name", "listing_title", "offer_code"]));

    const typo = await request(app).post("/v1/admin/notification-templates").set(auth(support)).send({ name: "Typo", title: "Hi {frist_name}", body: "x" });
    expect(typo.status).toBe(400);
    expect(typo.body.error.message).toContain("{frist_name}");
    const noListing = await request(app).post("/v1/admin/notification-templates").set(auth(support)).send({ name: "No listing", title: "See {listing_title}", body: "x" });
    expect(noListing.status).toBe(400);
    expect((await request(app).post("/v1/admin/notification-templates").set(auth(finance)).send({ name: "x", title: "x", body: "x" })).status).toBe(403);

    const made = await request(app)
      .post("/v1/admin/notification-templates")
      .set(auth(support))
      .send({ name: "Price drop", category: "new_listing", needs: "listing", title: "{listing_title} is now {listing_price}", body: "Hi {first_name|there}, good news." });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    templateIds.push(made.body.data.id);
    const edited = await request(app).patch(`/v1/admin/notification-templates/${made.body.data.id}`).set(auth(support)).send({ body: "Hi {first_name|there}, it just got cheaper." });
    expect(edited.body.data.body).toBe("Hi {first_name|there}, it just got cheaper.");
    expect((await request(app).delete(`/v1/admin/notification-templates/${made.body.data.id}`).set(auth(support))).status).toBe(200);
    const builtin = list.body.data.find((t: { is_builtin: boolean }) => t.is_builtin);
    expect((await request(app).delete(`/v1/admin/notification-templates/${builtin.id}`).set(auth(support))).status).toBe(409);
    const { data: audit } = await adminClient.from("admin_audit_log").select("action").eq("target_id", made.body.data.id);
    expect(audit!.map((a) => a.action).sort()).toEqual(["ADMIN_CREATED_NOTIFICATION_TEMPLATE", "ADMIN_DELETED_NOTIFICATION_TEMPLATE", "ADMIN_UPDATED_NOTIFICATION_TEMPLATE"]);
  });

  it("previews the text as a chosen person gets it, with the listing and offer filled in", async () => {
    const res = await request(app)
      .post("/v1/admin/campaigns/render-preview")
      .set(auth(support))
      .send({
        title: "New in {listing_city}: {listing_title}",
        body: "Hi {first_name|there}, from {listing_price}. Use {offer_code} for {offer_discount}{offer_ends}.",
        location_id: locationId,
        coupon_id: couponId,
        user_id: riya.id,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.title).toBe(`New in ${city}: Rooftop with a view`);
    expect(res.body.data.body).toMatch(/^Hi Riya, from ₹2,500\/hour\. Use TPL\d+ for 20% off until 31 Dec\.$/);
    expect(res.body.data.link_url).toBe(`prodbnb://location/${locationId}`);

    const fallback = await request(app).post("/v1/admin/campaigns/render-preview").set(auth(support)).send({ title: "Hi {first_name|there}", body: "Shoots{city_suffix}.", user_id: nameless.id });
    expect(fallback.body.data).toMatchObject({ title: "Hi there", missing: ["first_name"] });
    expect(fallback.body.data.body).toBe(`Shoots in ${city.toUpperCase()}.`);
  });

  it("targets a segment from onboarding answers", async () => {
    const preview = (audience: object) => request(app).post("/v1/admin/campaigns/audience-preview").set(auth(support)).send({ audience });
    expect((await preview({ type: "segment", cities: [city] })).body.data.users).toBe(3); // riya + nameless (prefs) + arjun (address)
    expect((await preview({ type: "segment", cities: [city], professions: ["director"] })).body.data.users).toBe(2);
    expect((await preview({ type: "segment", cities: [city], new_listing_alerts: true })).body.data.users).toBe(2);
    expect((await preview({ type: "segment", cities: [city], booked: "yes" })).body.data.users).toBe(0);
    const options = await request(app).get("/v1/admin/campaigns/audience-options").set(auth(support));
    expect(options.body.data.cities.find((c: { name: string }) => c.name.toLowerCase() === city.toLowerCase()).count).toBe(3);
    expect(options.body.data.professions.find((p: { value: string }) => p.value === "director").count).toBeGreaterThanOrEqual(2);
  });

  it("sends each person their own version of a listing announcement", async () => {
    const missingListing = await request(app)
      .post("/v1/admin/campaigns")
      .set(auth(support))
      .send({ name: "Listing", channels: ["in_app"], audience: { type: "segment", cities: [city] }, title: "{listing_title}", body: "Hi" });
    expect(missingListing.status).toBe(400);

    const c = await request(app)
      .post("/v1/admin/campaigns")
      .set(auth(support))
      .send({
        name: "New listing",
        channels: ["in_app"],
        audience: { type: "segment", cities: [city], professions: ["director"] },
        title: "New in {listing_city}: {listing_title}",
        body: "Hi {first_name|there}, it's {listing_price}.",
        location_id: locationId,
      });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    campaignIds.push(c.body.data.id);
    expect(c.body.data.location_id).toBe(locationId);
    const sent = await request(app).post(`/v1/admin/campaigns/${c.body.data.id}/send`).set(auth(support)).send({});
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.data.stats.in_app_created).toBe(2);

    const { data: notes } = await adminClient.from("notifications").select("user_id, title, body, data").eq("entity_id", c.body.data.id);
    const by = new Map((notes ?? []).map((n) => [n.user_id, n]));
    expect(by.get(riya.id)).toMatchObject({ title: `New in ${city}: Rooftop with a view`, body: "Hi Riya, it's ₹2,500/hour.", data: { link_url: `prodbnb://location/${locationId}` } });
    expect(by.get(nameless.id)).toMatchObject({ body: "Hi there, it's ₹2,500/hour." });
    expect(by.has(arjun.id)).toBe(false);
  });

  it("onboards: basics are required, the rest can be finished later", async () => {
    const fresh = await createTestUser();
    try {
      const me = await request(app).get("/v1/me").set(auth(fresh));
      expect(me.body.data.onboarding).toEqual({ basics_done: false, missing: expect.arrayContaining(["profession"]), completed: false });

      const early = await request(app).put("/v1/me/preferences").set(auth(fresh)).send({ professions: ["producer"], complete: true });
      expect(early.status).toBe(400);
      expect(early.body.error.message).toMatch(/your name and your mobile number/);

      await request(app).patch("/v1/me").set(auth(fresh)).send({ first_name: "Kabir", last_name: "Rao", phone: "+91 90000 11111" }).expect(200);
      expect((await request(app).put("/v1/me/preferences").set(auth(fresh)).send({ professions: ["astronaut"] })).status).toBe(400);
      const basics = await request(app).put("/v1/me/preferences").set(auth(fresh)).send({ professions: ["producer", "director", "producer"], company: "  Lantern Films " });
      expect(basics.body.data.onboarding).toEqual({ basics_done: true, missing: [], completed: false });
      expect(basics.body.data.preferences).toMatchObject({ professions: ["producer", "director"], company: "Lantern Films" });

      const { data: useCases } = await adminClient.from("use_cases").select("id").limit(2);
      const done = await request(app)
        .put("/v1/me/preferences")
        .set(auth(fresh))
        .send({ cities: ["Mumbai", " mumbai ", "Pune"], use_case_ids: (useCases ?? []).map((u) => u.id), heard_from: "social", complete: true });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body.data.preferences.cities).toEqual(["Mumbai", "Pune"]);
      expect(done.body.data.onboarding.completed).toBe(true);
      expect((await request(app).get("/v1/me").set(auth(fresh))).body.data.onboarding.completed).toBe(true);
      expect((await request(app).put("/v1/me/preferences").set(auth(fresh)).send({ use_case_ids: ["00000000-0000-4000-8000-000000000000"] })).status).toBe(400);
    } finally {
      await deleteTestUser(fresh.id).catch(() => undefined);
    }
  });
});

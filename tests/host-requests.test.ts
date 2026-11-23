import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { ROLE_PERMISSIONS } from "../src/modules/admin/permissions";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

/**
 * "Request a callback" for would-be hosts, and "Clear all" in the notifications inbox.
 * Runs against the local Supabase stack.
 */
const app = createApp();
const auth = (user: TestUser) => ({ Authorization: `Bearer ${user.accessToken}` });

describe("host callback requests", () => {
  let person: TestUser;
  let other: TestUser;
  let moderator: TestUser;
  let finance: TestUser;
  let draftId: string;
  let othersListingId: string;

  async function makeAdmin(user: TestUser, teamRole: "moderator" | "finance") {
    const { error } = await adminClient.from("user_roles").insert({ user_id: user.id, role: "admin" });
    if (error) throw error;
    const { error: e2 } = await adminClient.from("admin_team_members").update({ team_role: teamRole }).eq("user_id", user.id);
    if (e2) throw e2;
  }

  async function draftFor(user: TestUser, title: string): Promise<string> {
    expect((await request(app).post("/v1/me/roles").set(auth(user)).send({ role: "host" })).status).toBe(201);
    const res = await request(app)
      .post("/v1/locations")
      .set(auth(user))
      .send({ title, city: "Pune", country: "IN", latitude: 18.52, longitude: 73.85 });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  beforeAll(async () => {
    [person, other, moderator, finance] = await Promise.all([createTestUser(), createTestUser(), createTestUser(), createTestUser()]);
    await makeAdmin(moderator, "moderator");
    await makeAdmin(finance, "finance");
    draftId = await draftFor(person, "Callback test bungalow");
    othersListingId = await draftFor(other, "Someone else's flat");
  });

  afterAll(async () => {
    await adminClient.from("host_assistance_requests").delete().in("user_id", [person.id, other.id]);
    await adminClient.from("locations").delete().in("id", [draftId, othersListingId]);
    await Promise.all([person, other, moderator, finance].map((u) => deleteTestUser(u.id)));
  });

  it("starts with nothing", async () => {
    const res = await request(app).get("/v1/me/host-request").set(auth(person));
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it("needs a name and a real phone number, and only the person's own listing", async () => {
    expect((await request(app).post("/v1/me/host-request").set(auth(person)).send({ name: "", phone: "98765 43210" })).status).toBe(400);
    expect((await request(app).post("/v1/me/host-request").set(auth(person)).send({ name: "Asha", phone: "((((" })).status).toBe(400);
    const foreign = await request(app)
      .post("/v1/me/host-request")
      .set(auth(person))
      .send({ name: "Asha", phone: "98765 43210", location_id: othersListingId });
    expect(foreign.status).toBe(400);
  });

  it("files one request, and asking again updates it instead of making a second", async () => {
    const first = await request(app)
      .post("/v1/me/host-request")
      .set(auth(person))
      .set("X-ProdBnb-Platform", "ios")
      .send({ name: "Asha Rao", phone: "+91 98765 43210", city: "Pune", space_type: "Bungalow", best_time: "evening", note: "", location_id: draftId });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({
      name: "Asha Rao",
      city: "Pune",
      best_time: "evening",
      note: null,
      source: "ios",
      status: "new",
      location_id: draftId,
      email: person.email,
    });
    expect(first.body.data.admin_notes).toBeUndefined();

    const again = await request(app).post("/v1/me/host-request").set(auth(person)).send({ name: "Asha Rao", phone: "+91 90000 11111", best_time: "morning" });
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(again.body.data.phone).toBe("+91 90000 11111");
    // The listing named before is kept when the second ask doesn't name one.
    expect(again.body.data.location_id).toBe(draftId);

    const { count } = await adminClient.from("host_assistance_requests").select("id", { count: "exact", head: true }).eq("user_id", person.id);
    expect(count).toBe(1);
  });

  it("is in the team's list with the person, the listing and a count; finance can't see it", async () => {
    expect(ROLE_PERMISSIONS.finance).not.toContain("host_requests.manage");
    expect((await request(app).get("/v1/admin/host-requests").set(auth(finance))).status).toBe(403);

    const list = await request(app).get("/v1/admin/host-requests?status=open&search=Asha").set(auth(moderator));
    expect(list.status).toBe(200);
    const row = list.body.data.find((r: { user_id: string }) => r.user_id === person.id);
    expect(row).toBeTruthy();
    expect(row.user.id).toBe(person.id);
    expect(row.listing).toMatchObject({ id: draftId, title: "Callback test bungalow", status: "draft" });

    const summary = await request(app).get("/v1/admin/host-requests/summary").set(auth(moderator));
    expect(summary.status).toBe(200);
    expect(summary.body.data.new).toBeGreaterThanOrEqual(1);
  });

  it("the team moves it along and keeps notes the person never sees", async () => {
    const mine = (await request(app).get("/v1/me/host-request").set(auth(person))).body.data;
    const contacted = await request(app)
      .patch(`/v1/admin/host-requests/${mine.id}`)
      .set(auth(moderator))
      .send({ status: "contacted", admin_notes: "Called, will send photos Friday." });
    expect(contacted.status).toBe(200);
    expect(contacted.body.data.status).toBe("contacted");
    expect(contacted.body.data.contacted_at).toBeTruthy();
    expect(contacted.body.data.handler.id).toBe(moderator.id);
    expect(contacted.body.data.admin_notes).toBe("Called, will send photos Friday.");

    const seen = await request(app).get("/v1/me/host-request").set(auth(person));
    expect(seen.body.data.status).toBe("contacted");
    expect(seen.body.data.admin_notes).toBeUndefined();

    const done = await request(app).patch(`/v1/admin/host-requests/${mine.id}`).set(auth(moderator)).send({ status: "done" });
    expect(done.body.data.status).toBe("done");
    expect(done.body.data.closed_at).toBeTruthy();
    expect((await request(app).patch(`/v1/admin/host-requests/${mine.id}`).set(auth(moderator)).send({})).status).toBe(400);
  });

  it("after a request is done, asking again opens a new one, which the person can withdraw", async () => {
    const fresh = await request(app).post("/v1/me/host-request").set(auth(person)).send({ name: "Asha Rao", phone: "+91 90000 11111" });
    expect(fresh.status).toBe(201);
    expect(fresh.body.data.status).toBe("new");

    const withdrawn = await request(app).delete("/v1/me/host-request").set(auth(person));
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.data.status).toBe("withdrawn");
    expect((await request(app).delete("/v1/me/host-request").set(auth(person))).status).toBe(404);

    // A withdrawn request can't be reopened by the team.
    const reopen = await request(app).patch(`/v1/admin/host-requests/${fresh.body.data.id}`).set(auth(moderator)).send({ status: "new" });
    expect(reopen.status).toBe(409);

    // The latest non-withdrawn one (the done request) is what the person sees now.
    expect((await request(app).get("/v1/me/host-request").set(auth(person))).body.data.status).toBe("done");
  });

  it("needs sign-in", async () => {
    expect((await request(app).get("/v1/me/host-request")).status).toBe(401);
    expect((await request(app).post("/v1/me/host-request").send({ name: "A", phone: "98765 43210" })).status).toBe(401);
  });
});

describe("clear all notifications", () => {
  let user: TestUser;
  let otherUser: TestUser;

  async function notify(userId: string, createdAt: string, key: string) {
    const { error } = await adminClient.from("notifications").insert({
      user_id: userId,
      type: "booking_confirmed",
      title: "Booking confirmed",
      body: "See you there",
      entity_type: "booking",
      entity_id: crypto.randomUUID(),
      source_event_id: key,
      created_at: createdAt,
    });
    if (error) throw error;
  }

  beforeAll(async () => {
    [user, otherUser] = await Promise.all([createTestUser(), createTestUser()]);
    await notify(user.id, "2026-11-20T10:00:00Z", `clear-a-${user.id}`);
    await notify(user.id, "2026-11-21T10:00:00Z", `clear-b-${user.id}`);
    await notify(user.id, "2026-11-23T10:00:00Z", `clear-c-${user.id}`);
    await notify(otherUser.id, "2026-11-20T10:00:00Z", `clear-d-${otherUser.id}`);
  });

  afterAll(async () => {
    await Promise.all([user, otherUser].map((u) => deleteTestUser(u.id)));
  });

  it("clears up to `before`, keeps newer ones, and never touches anyone else's", async () => {
    const res = await request(app).delete("/v1/notifications?before=2026-11-22T00:00:00Z").set(auth(user));
    expect(res.status).toBe(200);
    expect(res.body.data.cleared).toBe(2);

    const left = await request(app).get("/v1/notifications").set(auth(user));
    expect(left.body.data).toHaveLength(1);
    expect(left.body.data[0].created_at.startsWith("2026-11-23")).toBe(true);

    const all = await request(app).delete("/v1/notifications").set(auth(user));
    expect(all.body.data.cleared).toBe(1);
    expect((await request(app).get("/v1/notifications").set(auth(user))).body.meta.total).toBe(0);

    expect((await request(app).get("/v1/notifications").set(auth(otherUser))).body.meta.total).toBe(1);
  });

  it("rejects a bad date", async () => {
    expect((await request(app).delete("/v1/notifications?before=yesterday").set(auth(user))).status).toBe(400);
  });
});

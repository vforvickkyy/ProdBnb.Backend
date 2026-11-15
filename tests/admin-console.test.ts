import { randomUUID } from "crypto";
import { createClient } from "@supabase/supabase-js";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// R2 is mocked wholesale, exactly as tests/media.test.ts does -- no real bucket needed.
const deletedKeys = vi.hoisted(() => new Set<string>());
vi.mock("../src/lib/r2", () => ({
  objectKeyFor: (locationId: string, mediaId: string) => `locations/${locationId}/${mediaId}/original`,
  publicUrlFor: (key: string) => `https://mock-cdn.example.com/${key}`,
  presignUpload: async () => ({ url: "https://mock-r2.example.com/x", expiresAt: new Date(Date.now() + 900_000) }),
  headObject: async () => null,
  deleteObject: async (key: string) => {
    deletedKeys.add(key);
  },
  checkBucketAccess: async () => undefined,
}));

import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { resetPlatformSettingsCacheForTesting } from "../src/modules/platform/settings.service";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

const app = createApp();
const CONSOLE_CITY = `Console City ${randomUUID().slice(0, 8)}`;

function auth(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${user.accessToken}` };
}

async function grantRole(user: TestUser, role: "host" | "booker"): Promise<void> {
  const res = await request(app).post("/v1/me/roles").set(auth(user)).send({ role });
  expect(res.status).toBe(201);
}

/** The documented SQL bootstrap path: a raw user_roles 'admin' row (trigger -> super_admin). */
async function bootstrapSuperAdmin(user: TestUser): Promise<void> {
  const { error } = await adminClient.from("user_roles").insert({ user_id: user.id, role: "admin" });
  if (error) throw error;
}

async function resetSettings(): Promise<void> {
  const { error } = await adminClient
    .from("platform_settings")
    .update({ platform_fee_bps: 0, tax_bps: 0, unpaid_hold_minutes: null })
    .eq("singleton", true);
  if (error) throw error;
  resetPlatformSettingsCacheForTesting();
}

/** A published listing open 09:00-18:00 UTC every Monday, hourly at 100.00. */
async function createBookableLocation(owner: TestUser, instant = false): Promise<string> {
  const res = await request(app)
    .post("/v1/locations")
    .set(auth(owner))
    // A city no other suite searches for: hosts with bookings cannot be deleted (bookings.location_id
    // has no cascade, by design), so this listing outlives the test -- it must not leak into
    // search.test.ts's exact-match city assertions.
    .send({ title: "Console Test Studio", city: CONSOLE_CITY, country: "India", instant_booking_enabled: instant });
  expect(res.status).toBe(201);
  const id = res.body.data.id as string;
  await request(app)
    .post(`/v1/locations/${id}/availability/rules`)
    .set(auth(owner))
    .send({ day_of_week: "monday", start_time: "09:00", end_time: "18:00" })
    .expect(201);
  await request(app)
    .post(`/v1/locations/${id}/pricing`)
    .set(auth(owner))
    .send({ booking_type: "hourly", amount_minor_units: 10000 })
    .expect(201);
  const { error } = await adminClient.from("locations").update({ status: "published" }).eq("id", id);
  if (error) throw error;
  return id;
}

// Mondays well in the future, one per test that books, so tests never collide on an interval.
let mondayCursor = 0;
function nextMondaySlot(): { start_at: string; end_at: string; date: string } {
  mondayCursor += 1;
  const base = new Date(Date.UTC(2027, 0, 4)); // Monday 4 Jan 2027
  base.setUTCDate(base.getUTCDate() + 7 * mondayCursor);
  const date = base.toISOString().slice(0, 10);
  return { start_at: `${date}T10:00:00Z`, end_at: `${date}T11:00:00Z`, date };
}

async function book(booker: TestUser, locationId: string, slot = nextMondaySlot()): Promise<{ id: string; slot: typeof slot }> {
  const res = await request(app).post("/v1/bookings").set(auth(booker)).send({ location_id: locationId, start_at: slot.start_at, end_at: slot.end_at });
  expect(res.status).toBe(201);
  return { id: res.body.data.id as string, slot };
}

async function insertPayment(bookingId: string, status: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  const { error } = await adminClient.from("payments").insert({
    id,
    booking_id: bookingId,
    provider: "cashfree",
    provider_order_id: `pb_test_${id.replace(/-/g, "")}`,
    status,
    amount_minor_units: 10000,
    currency: "INR",
    ...extra,
  });
  if (error) throw error;
  return id;
}

async function latestAudit(action: string, targetId: string) {
  const { data, error } = await adminClient
    .from("admin_audit_log")
    .select("*")
    .eq("action", action)
    .eq("target_id", targetId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

describe("Admin Console", () => {
  let superAdmin: TestUser;
  let moderator: TestUser;
  let support: TestUser;
  let finance: TestUser;
  let host: TestUser;
  let booker: TestUser;
  let outsider: TestUser;
  let locationId: string;

  beforeAll(async () => {
    [superAdmin, moderator, support, finance, host, booker, outsider] = await Promise.all(
      Array.from({ length: 7 }, () => createTestUser())
    );
    await bootstrapSuperAdmin(superAdmin);
    for (const [user, team_role] of [
      [moderator, "moderator"],
      [support, "support"],
      [finance, "finance"],
    ] as const) {
      const res = await request(app).post("/v1/admin/team").set(auth(superAdmin)).send({ email: user.email, team_role });
      expect(res.status).toBe(201);
    }
    await grantRole(host, "host");
    await grantRole(booker, "booker");
    locationId = await createBookableLocation(host);
  });

  afterEach(async () => {
    await resetSettings();
  });

  afterAll(async () => {
    await resetSettings();
    // Take this suite's listing out of public search before the (best-effort) user cleanup.
    await adminClient.from("locations").update({ status: "archived" }).eq("city", CONSOLE_CITY);
    for (const user of [superAdmin, moderator, support, finance, host, booker, outsider]) {
      await deleteTestUser(user.id);
    }
  });

  // -- Team roles ------------------------------------------------------------------------------

  describe("team roles", () => {
    it("the SQL bootstrap path yields a super admin, and /me reports role + permissions", async () => {
      const res = await request(app).get("/v1/admin/me").set(auth(superAdmin));
      expect(res.status).toBe(200);
      expect(res.body.data.team_role).toBe("super_admin");
      expect(res.body.data.permissions).toContain("team.manage");

      const mod = await request(app).get("/v1/admin/me").set(auth(moderator));
      expect(mod.body.data.team_role).toBe("moderator");
      expect(mod.body.data.permissions).toContain("locations.moderate");
      expect(mod.body.data.permissions).not.toContain("payments.refund");
    });

    it("team members hold the platform admin role (RLS reads keep working)", async () => {
      const { data } = await adminClient.from("user_roles").select("role").eq("user_id", support.id);
      expect((data ?? []).map((r) => r.role)).toContain("admin");
    });

    it("a non-super-admin cannot manage the team", async () => {
      const res = await request(app).post("/v1/admin/team").set(auth(moderator)).send({ email: outsider.email, team_role: "support" });
      expect(res.status).toBe(403);
      const del = await request(app).delete(`/v1/admin/team/${support.id}`).set(auth(moderator));
      expect(del.status).toBe(403);
    });

    it("adding an unknown email is a clean 404", async () => {
      const res = await request(app)
        .post("/v1/admin/team")
        .set(auth(superAdmin))
        .send({ email: `nobody-${randomUUID()}@example.com`, team_role: "support" });
      expect(res.status).toBe(404);
    });

    it("changing and removing a member is audited, and removal drops the admin role", async () => {
      const add = await request(app).post("/v1/admin/team").set(auth(superAdmin)).send({ email: outsider.email, team_role: "support" });
      expect(add.status).toBe(201);
      const change = await request(app).put(`/v1/admin/team/${outsider.id}`).set(auth(superAdmin)).send({ team_role: "finance" });
      expect(change.status).toBe(200);
      expect(change.body.data.team_role).toBe("finance");
      const audit = await latestAudit("ADMIN_SET_TEAM_ROLE", outsider.id);
      expect(audit?.metadata).toMatchObject({ previous_team_role: "support", new_team_role: "finance" });

      const remove = await request(app).delete(`/v1/admin/team/${outsider.id}`).set(auth(superAdmin));
      expect(remove.status).toBe(200);
      const { data } = await adminClient.from("user_roles").select("role").eq("user_id", outsider.id);
      expect((data ?? []).map((r) => r.role)).not.toContain("admin");
      const gone = await request(app).get("/v1/admin/dashboard").set(auth(outsider));
      expect(gone.status).toBe(403);
    });

    it("nobody can remove themselves", async () => {
      const res = await request(app).delete(`/v1/admin/team/${superAdmin.id}`).set(auth(superAdmin));
      expect(res.status).toBe(400);
    });

    it("the last super admin cannot be demoted", async () => {
      const { count } = await adminClient
        .from("admin_team_members")
        .select("user_id", { count: "exact", head: true })
        .eq("team_role", "super_admin");
      // Other files' admins are deleted in their own afterAll; when this file's super admin is the
      // only one left (the normal serial-run case) the guard must fire.
      if (count === 1) {
        const res = await request(app).put(`/v1/admin/team/${superAdmin.id}`).set(auth(superAdmin)).send({ team_role: "support" });
        expect(res.status).toBe(409);
      }
    });

    it("an admin can no longer mint another admin through raw PostgREST (escalation closed)", async () => {
      const scoped = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${support.accessToken}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error } = await scoped.from("user_roles").insert({ user_id: outsider.id, role: "admin" });
      expect(error).toBeTruthy();
      const { data } = await adminClient.from("user_roles").select("role").eq("user_id", outsider.id).eq("role", "admin");
      expect(data).toEqual([]);
    });

    it("permissions are enforced on the shared (non-admin) routes too", async () => {
      // A support admin may not refund through the generic route any more than the admin one.
      const { id: bookingId } = await book(booker, locationId);
      const paymentId = await insertPayment(bookingId, "success");
      const generic = await request(app).post(`/v1/payments/${paymentId}/refunds`).set(auth(support)).send({ amount_minor_units: 100 });
      expect(generic.status).toBe(403);
      const dedicated = await request(app).post(`/v1/admin/payments/${paymentId}/refunds`).set(auth(support)).send({ amount_minor_units: 100 });
      expect(dedicated.status).toBe(403);
      // ...and a moderator may not edit someone's pricing via the generic route.
      const pricing = await request(app)
        .post(`/v1/locations/${locationId}/pricing`)
        .set(auth(support))
        .send({ booking_type: "day", amount_minor_units: 50000 });
      expect(pricing.status).toBe(403);
    });

    it("only a super admin can suspend a fellow admin; nobody can suspend themselves", async () => {
      const res = await request(app).post(`/v1/admin/users/${support.id}/suspend`).set(auth(moderator)).send({ reason: "test" });
      expect(res.status).toBe(403);
      const self = await request(app).post(`/v1/admin/users/${moderator.id}/suspend`).set(auth(moderator)).send({ reason: "test" });
      expect(self.status).toBe(400);
    });
  });

  // -- Platform settings ---------------------------------------------------------------------------

  describe("platform settings", () => {
    it("defaults to no fee, no tax, expiry off", async () => {
      const res = await request(app).get("/v1/admin/settings").set(auth(moderator));
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ platform_fee_bps: 0, tax_bps: 0, unpaid_hold_minutes: null });
    });

    it("only a super admin can change settings, within bounds", async () => {
      expect((await request(app).patch("/v1/admin/settings").set(auth(finance)).send({ tax_bps: 1800 })).status).toBe(403);
      expect((await request(app).patch("/v1/admin/settings").set(auth(superAdmin)).send({ tax_bps: 9000 })).status).toBe(400);
      expect((await request(app).patch("/v1/admin/settings").set(auth(superAdmin)).send({ unpaid_hold_minutes: 1 })).status).toBe(400);
      expect((await request(app).patch("/v1/admin/settings").set(auth(superAdmin)).send({})).status).toBe(400);
    });

    it("fee and tax apply to new bookings and the change is audited", async () => {
      const res = await request(app)
        .patch("/v1/admin/settings")
        .set(auth(superAdmin))
        .send({ platform_fee_bps: 1000, tax_bps: 1800, reason: "Launch pricing" });
      expect(res.status).toBe(200);
      const audit = await latestAudit("ADMIN_UPDATED_SETTINGS", res.body.data.id);
      expect(audit?.reason).toBe("Launch pricing");
      expect(audit?.metadata.changes.platform_fee_bps).toEqual({ from: 0, to: 1000 });

      const slot = nextMondaySlot();
      const booking = await request(app)
        .post("/v1/bookings")
        .set(auth(booker))
        .send({ location_id: locationId, start_at: slot.start_at, end_at: slot.end_at });
      expect(booking.status).toBe(201);
      // base 100.00, fee 10% = 10.00, tax 18% of 110.00 = 19.80
      expect(booking.body.data.pricing).toMatchObject({
        base_amount_minor_units: 10000,
        platform_fee_minor_units: 1000,
        tax_minor_units: 1980,
        total_amount_minor_units: 12980,
      });
    });

    it("with defaults, a booking prices exactly as before", async () => {
      const { id } = await book(booker, locationId);
      const res = await request(app).get(`/v1/bookings/${id}`).set(auth(booker));
      expect(res.body.data.pricing).toMatchObject({ platform_fee_minor_units: 0, tax_minor_units: 0, total_amount_minor_units: 10000 });
    });
  });

  // -- Unpaid hold expiry ----------------------------------------------------------------------------

  describe("unpaid hold expiry", () => {
    async function backdate(bookingId: string, minutes: number): Promise<void> {
      const { error } = await adminClient
        .from("bookings")
        .update({ created_at: new Date(Date.now() - minutes * 60_000).toISOString() })
        .eq("id", bookingId);
      if (error) throw error;
    }
    async function statusOf(bookingId: string) {
      const { data } = await adminClient.from("bookings").select("status, hold_expired_at, cancelled_by").eq("id", bookingId).single();
      return data!;
    }
    async function enableHolds(minutes = 15): Promise<void> {
      const res = await request(app).patch("/v1/admin/settings").set(auth(superAdmin)).send({ unpaid_hold_minutes: minutes });
      expect(res.status).toBe(200);
    }

    it("is off by default: an old unpaid booking keeps its slot", async () => {
      const { id, slot } = await book(booker, locationId);
      await backdate(id, 120);
      await request(app).get(`/v1/locations/${locationId}/availability`).query({ from: slot.date, to: slot.date }).expect(200);
      expect((await statusOf(id)).status).toBe("requested");
    });

    it("releases a lapsed unpaid hold before availability is computed, and tells the booker in-app", async () => {
      await enableHolds(15);
      const { id, slot } = await book(booker, locationId);
      await backdate(id, 20);

      const availability = await request(app).get(`/v1/locations/${locationId}/availability`).query({ from: slot.date, to: slot.date });
      expect(availability.status).toBe(200);

      const after = await statusOf(id);
      expect(after.status).toBe("cancelled");
      expect(after.hold_expired_at).not.toBeNull();
      expect(after.cancelled_by).toBeNull();

      const { data: notes } = await adminClient
        .from("notifications")
        .select("type, data")
        .eq("user_id", booker.id)
        .eq("entity_id", id);
      expect(notes).toEqual([{ type: "booking_cancelled", data: { reason: "unpaid_hold_expired" } }]);

      // The slot is bookable again immediately.
      await book(booker, locationId, slot);
    });

    it("never expires a paid booking, or one whose checkout is still open", async () => {
      await enableHolds(15);
      const paid = await book(booker, locationId);
      await insertPayment(paid.id, "success");
      await backdate(paid.id, 60);

      const midCheckout = await book(booker, locationId);
      const paymentId = await insertPayment(midCheckout.id, "pending", { expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
      await backdate(midCheckout.id, 60);

      await adminClient.rpc("expire_unpaid_bookings", { _location_id: locationId });
      expect((await statusOf(paid.id)).status).toBe("requested");
      expect((await statusOf(midCheckout.id)).status).toBe("requested");

      // Once that checkout's own window has closed, the hold lapses too.
      await adminClient.from("payments").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", paymentId);
      await adminClient.rpc("expire_unpaid_bookings", { _location_id: locationId });
      expect((await statusOf(midCheckout.id)).status).toBe("cancelled");
    });

    it("admin bookings carry a hold deadline for unpaid active bookings only", async () => {
      await enableHolds(30);
      const unpaid = await book(booker, locationId);
      const paid = await book(booker, locationId);
      await insertPayment(paid.id, "success");

      const res = await request(app).get("/v1/admin/bookings").set(auth(support)).query({ location_id: locationId, pageSize: 100 });
      const byId = new Map<string, { hold_expires_at: string | null }>(res.body.data.map((b: { id: string }) => [b.id, b]));
      expect(byId.get(unpaid.id)?.hold_expires_at).toBeTruthy();
      expect(byId.get(paid.id)?.hold_expires_at).toBeNull();
    });
  });

  // -- Bookings & payments -----------------------------------------------------------------------------

  describe("booking and payment operations", () => {
    it("filters bookings by payment state", async () => {
      const unpaid = await book(booker, locationId);
      const paid = await book(booker, locationId);
      await insertPayment(paid.id, "success");

      const unpaidList = await request(app).get("/v1/admin/bookings").set(auth(support)).query({ location_id: locationId, payment_state: "unpaid", pageSize: 100 });
      const paidList = await request(app).get("/v1/admin/bookings").set(auth(support)).query({ location_id: locationId, payment_state: "paid", pageSize: 100 });
      const unpaidIds = unpaidList.body.data.map((b: { id: string }) => b.id);
      const paidIds = paidList.body.data.map((b: { id: string }) => b.id);
      expect(unpaidIds).toContain(unpaid.id);
      expect(unpaidIds).not.toContain(paid.id);
      expect(paidIds).toContain(paid.id);
      expect(paidIds).not.toContain(unpaid.id);
    });

    it("support can confirm and complete on a host's behalf, audited; a moderator cannot", async () => {
      const { id } = await book(booker, locationId);
      expect((await request(app).post(`/v1/admin/bookings/${id}/confirm`).set(auth(moderator)).send({})).status).toBe(403);

      const confirmed = await request(app).post(`/v1/admin/bookings/${id}/confirm`).set(auth(support)).send({});
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.data.status).toBe("confirmed");
      expect(await latestAudit("ADMIN_CONFIRMED_BOOKING", id)).toBeTruthy();

      const completed = await request(app).post(`/v1/admin/bookings/${id}/complete`).set(auth(support)).send({});
      expect(completed.body.data.status).toBe("completed");
      expect(await latestAudit("ADMIN_COMPLETED_BOOKING", id)).toBeTruthy();
    });

    it("support can reject with a reason, audited", async () => {
      const { id } = await book(booker, locationId);
      const res = await request(app).post(`/v1/admin/bookings/${id}/reject`).set(auth(support)).send({ reason: "Venue unavailable" });
      expect(res.status).toBe(200);
      expect((await latestAudit("ADMIN_REJECTED_BOOKING", id))?.reason).toBe("Venue unavailable");
    });

    it("queues money taken for a booking that is no longer happening", async () => {
      const { id } = await book(booker, locationId);
      const paymentId = await insertPayment(id, "success");
      await request(app).post(`/v1/admin/bookings/${id}/cancel`).set(auth(support)).send({ reason: "Booker request" }).expect(200);

      const res = await request(app).get("/v1/admin/payments/attention").set(auth(finance)).query({ pageSize: 100 });
      expect(res.status).toBe(200);
      const row = res.body.data.find((p: { id: string }) => p.id === paymentId);
      expect(row).toMatchObject({ booking_status: "cancelled", refunded_minor_units: 0, hold_expired: false });

      const dashboard = await request(app).get("/v1/admin/dashboard").set(auth(finance));
      expect(dashboard.body.data.payments_needing_attention).toBeGreaterThanOrEqual(1);
      expect(typeof dashboard.body.data.unpaid_holds).toBe("number");
    });
  });

  // -- People -------------------------------------------------------------------------------------------

  describe("people", () => {
    it("moderators grant and revoke booker/host roles, audited; duplicates are a conflict", async () => {
      const grant = await request(app).post(`/v1/admin/users/${outsider.id}/roles/host`).set(auth(moderator));
      expect(grant.status).toBe(201);
      expect(grant.body.data.roles).toContain("host");
      expect((await request(app).post(`/v1/admin/users/${outsider.id}/roles/host`).set(auth(moderator))).status).toBe(409);
      expect(await latestAudit("ADMIN_GRANTED_ROLE", outsider.id)).toBeTruthy();

      const revoke = await request(app).delete(`/v1/admin/users/${outsider.id}/roles/host`).set(auth(moderator));
      expect(revoke.status).toBe(200);
      expect(revoke.body.data.roles).not.toContain("host");
      expect((await request(app).post(`/v1/admin/users/${outsider.id}/roles/admin`).set(auth(superAdmin))).status).toBe(400);
    });

    it("user detail includes team role, contact and billing", async () => {
      await adminClient.from("user_billing_profiles").upsert({ user_id: host.id, company_name: "Lights Co", gst_number: null });
      const res = await request(app).get(`/v1/admin/users/${host.id}`).set(auth(support));
      expect(res.status).toBe(200);
      expect(res.body.data.billing).toMatchObject({ company_name: "Lights Co" });
      expect(res.body.data.contact).toHaveProperty("phone");
      expect(res.body.data.team_role).toBeNull();
      const mod = await request(app).get(`/v1/admin/users/${moderator.id}`).set(auth(support));
      expect(mod.body.data.team_role).toBe("moderator");
    });
  });

  // -- Listing moderation & catalog ------------------------------------------------------------------------

  describe("listings and catalog", () => {
    it("a moderator's content edit on someone's listing is audited with the fields changed", async () => {
      const res = await request(app)
        .patch(`/v1/admin/locations/${locationId}`)
        .set(auth(moderator))
        .send({ title: "Console Test Studio (corrected)", reason: "Typo in title" });
      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe("Console Test Studio (corrected)");
      const audit = await latestAudit("ADMIN_UPDATED_LOCATION", locationId);
      expect(audit).toMatchObject({ reason: "Typo in title", metadata: { fields: ["title"] } });
      expect((await request(app).patch(`/v1/admin/locations/${locationId}`).set(auth(support)).send({ title: "x" })).status).toBe(403);
      // status never moves through this route
      expect((await request(app).patch(`/v1/admin/locations/${locationId}`).set(auth(moderator)).send({ status: "archived" })).status).toBe(400);
    });

    it("gallery lists every photo; removing one is audited and deletes the stored object", async () => {
      const mediaId = randomUUID();
      const { error } = await adminClient.from("location_media").insert({
        id: mediaId,
        location_id: locationId,
        media_type: "photo",
        storage_key: `locations/${locationId}/${mediaId}/original`,
        position: 0,
      });
      if (error) throw error;

      const gallery = await request(app).get(`/v1/admin/locations/${locationId}/gallery`).set(auth(support));
      expect(gallery.status).toBe(200);
      expect(gallery.body.data.general.map((m: { id: string }) => m.id)).toContain(mediaId);

      const del = await request(app).post(`/v1/admin/locations/${locationId}/media/${mediaId}/remove`).set(auth(moderator)).send({ reason: "Contains a phone number" });
      expect(del.status).toBe(200);
      expect(deletedKeys.has(`locations/${locationId}/${mediaId}/original`)).toBe(true);
      expect((await latestAudit("ADMIN_DELETED_MEDIA", mediaId))?.reason).toBe("Contains a phone number");
    });

    it("manages catalog items, refusing duplicates and refusing to delete one in use", async () => {
      const name = `Drone Zone ${randomUUID().slice(0, 8)}`;
      const created = await request(app).post("/v1/admin/catalog/amenities").set(auth(moderator)).send({ name });
      expect(created.status).toBe(201);
      const itemId = created.body.data.id as string;
      expect((await request(app).post("/v1/admin/catalog/amenities").set(auth(moderator)).send({ name })).status).toBe(409);
      expect((await request(app).post("/v1/admin/catalog/amenities").set(auth(support)).send({ name: "x" })).status).toBe(403);

      await adminClient.from("location_amenities").insert({ location_id: locationId, amenity_id: itemId });
      const list = await request(app).get("/v1/admin/catalog/amenities").set(auth(support));
      expect(list.body.data.find((i: { id: string }) => i.id === itemId)?.usage_count).toBe(1);
      expect((await request(app).delete(`/v1/admin/catalog/amenities/${itemId}`).set(auth(moderator))).status).toBe(409);

      const renamed = await request(app).patch(`/v1/admin/catalog/amenities/${itemId}`).set(auth(moderator)).send({ name: `${name} Pro` });
      expect(renamed.body.data.name).toBe(`${name} Pro`);

      await adminClient.from("location_amenities").delete().eq("amenity_id", itemId);
      expect((await request(app).delete(`/v1/admin/catalog/amenities/${itemId}`).set(auth(moderator))).status).toBe(200);
      expect(await latestAudit("ADMIN_DELETED_CATALOG_ITEM", itemId)).toBeTruthy();
    });
  });

  // -- Dispute message access ------------------------------------------------------------------------------

  describe("dispute message access", () => {
    let conversationId: string;
    const secretText = `Gate code is 4471-${randomUUID().slice(0, 6)}`;

    beforeAll(async () => {
      const conv = await request(app).post("/v1/conversations").set(auth(booker)).send({ location_id: locationId });
      expect(conv.status).toBe(201);
      conversationId = conv.body.data.id;
      await request(app)
        .post(`/v1/conversations/${conversationId}/messages`)
        .set(auth(booker))
        .send({ body: secretText, client_message_id: randomUUID() })
        .expect(201);
    });

    it("finding a conversation returns metadata only -- never message text", async () => {
      const res = await request(app).get("/v1/admin/conversations").set(auth(support)).query({ booker_id: booker.id });
      expect(res.status).toBe(200);
      const row = res.body.data.find((c: { id: string }) => c.id === conversationId);
      expect(row).toMatchObject({ message_count: 1, location: { id: locationId } });
      expect(JSON.stringify(res.body)).not.toContain(secretText);
      expect((await request(app).get("/v1/admin/conversations").set(auth(moderator))).status).toBe(403);
    });

    it("reading requires a real reason and leaves a permanent record", async () => {
      expect((await request(app).post(`/v1/admin/conversations/${conversationId}/access`).set(auth(support)).send({})).status).toBe(400);
      expect((await request(app).post(`/v1/admin/conversations/${conversationId}/access`).set(auth(support)).send({ reason: "why" })).status).toBe(400);

      const res = await request(app)
        .post(`/v1/admin/conversations/${conversationId}/access`)
        .set(auth(support))
        .send({ reason: "Dispute #42: booker says host demanded cash" });
      expect(res.status).toBe(200);
      expect(res.body.data.messages).toEqual([expect.objectContaining({ body: secretText, sender_role: "booker" })]);

      const log = await request(app).get("/v1/admin/message-access-log").set(auth(moderator)).query({ conversation_id: conversationId });
      expect(log.status).toBe(200);
      expect(log.body.data[0]).toMatchObject({ admin_user_id: support.id, reason: "Dispute #42: booker says host demanded cash" });
    });
  });

  // -- Analytics & integrations ----------------------------------------------------------------------------

  describe("analytics and integrations", () => {
    it("finance sees analytics; a moderator does not; ranges are validated", async () => {
      const to = new Date().toISOString();
      const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const res = await request(app).get("/v1/admin/analytics").set(auth(finance)).query({ from, to, bucket: "week" });
      expect(res.status).toBe(200);
      expect(res.body.data.totals).toHaveProperty("gmv_minor");
      expect(Array.isArray(res.body.data.series)).toBe(true);
      expect((await request(app).get("/v1/admin/analytics").set(auth(moderator)).query({ from, to })).status).toBe(403);
      expect((await request(app).get("/v1/admin/analytics").set(auth(finance)).query({ from: to, to: from })).status).toBe(400);
    });

    it("integrations report never contains a secret value, with or without live checks", async () => {
      const realFetch = globalThis.fetch;
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("cashfree.com")) {
          return new Response(JSON.stringify({ message: "order not found" }), { status: 404 });
        }
        return realFetch(input, init);
      });
      try {
        for (const check of ["false", "true"]) {
          const res = await request(app).get("/v1/admin/system/integrations").set(auth(superAdmin)).query({ check });
          expect(res.status).toBe(200);
          const body = JSON.stringify(res.body);
          type Setting = { kind: string; display: string | null };
          const settings: Setting[] = res.body.data.integrations.flatMap((i: { settings: Setting[] }) => i.settings);
          // Every secret row carries no display at all...
          expect(settings.filter((s) => s.kind === "secret").every((s) => s.display === null)).toBe(true);
          // ...and no secret value appears anywhere in the body. (A placeholder .env can reuse one
          // dummy string for a secret and a public setting alike; such a value proves nothing either
          // way, so it is skipped rather than reported as a leak.)
          const publicValues = new Set(settings.filter((s) => s.kind === "public").map((s) => s.display));
          for (const secret of [env.SUPABASE_SERVICE_ROLE_KEY, env.CASHFREE_SECRET_KEY, env.R2_SECRET_ACCESS_KEY, env.R2_ACCESS_KEY_ID]) {
            if (!publicValues.has(secret)) {
              expect(body).not.toContain(secret);
            }
          }
          const supabase = res.body.data.integrations.find((i: { id: string }) => i.id === "supabase");
          expect(supabase.settings.find((s: { key: string }) => s.key === "SUPABASE_SERVICE_ROLE_KEY")).toMatchObject({ set: true, display: null });
          if (check === "true") {
            expect(supabase.status).toBe("ok");
            expect(res.body.data.integrations.find((i: { id: string }) => i.id === "cashfree").status).not.toBe("error");
          }
        }
      } finally {
        spy.mockRestore();
      }
      expect((await request(app).get("/v1/admin/system/integrations").set(auth(support))).status).toBe(403);
    });
  });
});

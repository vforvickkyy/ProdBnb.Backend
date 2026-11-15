import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { hasValidGstinChecksum } from "../src/modules/billing/billing.schema";
import { createTestUser, deleteTestUser, grantAdminRole, TestUser } from "./setup";
import { createClient } from "@supabase/supabase-js";
import { env } from "../src/config/env";

const app = createApp();

/** Real GSTINs whose check digit verifies. */
const VALID_GSTIN = "27AAPFU0939F1ZV";
const OTHER_VALID_GSTIN = "29AAGCB7383J1Z4";
/** Structurally correct (matches the regex) but the check digit is wrong. */
const BAD_CHECKSUM_GSTIN = "19AABCT1332L1ZU";

function userClient(accessToken: string) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

describe("Phase 29-17G: billing profiles", () => {
  let userA: TestUser;
  let userB: TestUser;
  let admin: TestUser;

  beforeAll(async () => {
    userA = await createTestUser();
    userB = await createTestUser();
    admin = await createTestUser();
    await grantAdminRole(admin.id);
  });

  afterAll(async () => {
    await deleteTestUser(userA.id);
    await deleteTestUser(userB.id);
    await deleteTestUser(admin.id);
  });

  // ── Schema ────────────────────────────────────────────────────────────────

  describe("schema", () => {
    it("has exactly the approved columns, and no others", async () => {
      const client = userClient(userA.accessToken);
      await request(app)
        .put("/v1/me/billing")
        .set("Authorization", `Bearer ${userA.accessToken}`)
        .send({ company_name: "Eastlight Films", gst_number: VALID_GSTIN });

      const { data, error } = await client.from("user_billing_profiles").select("*").eq("user_id", userA.id).single();

      expect(error).toBeNull();
      expect(Object.keys(data!).sort()).toEqual(
        ["company_name", "created_at", "gst_number", "updated_at", "user_id"].sort()
      );
    });

    it("enforces one row per user -- a second insert is a unique violation", async () => {
      const client = userClient(userB.accessToken);
      const first = await client.from("user_billing_profiles").insert({ user_id: userB.id, company_name: "First" });
      expect(first.error).toBeNull();

      const second = await client.from("user_billing_profiles").insert({ user_id: userB.id, company_name: "Second" });
      expect(second.error?.code).toBe("23505"); // unique_violation

      await client.from("user_billing_profiles").delete().eq("user_id", userB.id);
    });

    it("rejects a structurally invalid GSTIN at the database layer", async () => {
      const client = userClient(userB.accessToken);
      const { error } = await client
        .from("user_billing_profiles")
        .insert({ user_id: userB.id, gst_number: "NOT-A-GSTIN" });

      expect(error?.code).toBe("23514"); // check_violation
    });

    it("rejects a blank company name at the database layer", async () => {
      const client = userClient(userB.accessToken);
      const { error } = await client.from("user_billing_profiles").insert({ user_id: userB.id, company_name: "   " });

      expect(error?.code).toBe("23514");
    });

    it("maintains updated_at on write", async () => {
      const before = await request(app)
        .put("/v1/me/billing")
        .set("Authorization", `Bearer ${userA.accessToken}`)
        .send({ company_name: "Before" });

      await new Promise((resolve) => setTimeout(resolve, 1100));

      const after = await request(app)
        .put("/v1/me/billing")
        .set("Authorization", `Bearer ${userA.accessToken}`)
        .send({ company_name: "After" });

      expect(new Date(after.body.data.billing.updated_at).getTime()).toBeGreaterThan(
        new Date(before.body.data.billing.updated_at).getTime()
      );
      expect(after.body.data.billing.created_at).toBe(before.body.data.billing.created_at);
    });

    it("does not touch public.profiles", async () => {
      const res = await request(app).get("/v1/me").set("Authorization", `Bearer ${userA.accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.profile).not.toHaveProperty("company_name");
      expect(res.body.data.profile).not.toHaveProperty("gst_number");
      // Phone is explicitly out of scope for this phase and must still be present.
      expect(res.body.data.profile).toHaveProperty("phone");
    });
  });

  // ── Create / read / update / clear ────────────────────────────────────────

  describe("API", () => {
    it("returns null for a user who has never supplied billing details", async () => {
      const fresh = await createTestUser();
      try {
        const res = await request(app).get("/v1/me/billing").set("Authorization", `Bearer ${fresh.accessToken}`);

        expect(res.status).toBe(200);
        expect(res.body.data.billing).toBeNull();
      } finally {
        await deleteTestUser(fresh.id);
      }
    });

    it("creates billing details", async () => {
      const res = await request(app)
        .put("/v1/me/billing")
        .set("Authorization", `Bearer ${userA.accessToken}`)
        .send({ company_name: "Eastlight Films", gst_number: VALID_GSTIN });

      expect(res.status).toBe(200);
      expect(res.body.data.billing.company_name).toBe("Eastlight Films");
      expect(res.body.data.billing.gst_number).toBe(VALID_GSTIN);
      expect(res.body.data.billing.user_id).toBe(userA.id);
    });

    it("reads back what was written", async () => {
      const res = await request(app).get("/v1/me/billing").set("Authorization", `Bearer ${userA.accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.billing.gst_number).toBe(VALID_GSTIN);
    });

    it("updates existing details in place, keeping one row", async () => {
      const res = await request(app)
        .put("/v1/me/billing")
        .set("Authorization", `Bearer ${userA.accessToken}`)
        .send({ company_name: "Eastlight Productions", gst_number: OTHER_VALID_GSTIN });

      expect(res.status).toBe(200);
      expect(res.body.data.billing.company_name).toBe("Eastlight Productions");
      expect(res.body.data.billing.gst_number).toBe(OTHER_VALID_GSTIN);

      const client = userClient(userA.accessToken);
      const { data } = await client.from("user_billing_profiles").select("user_id").eq("user_id", userA.id);
      expect(data).toHaveLength(1);
    });

    it("clears a single field when it is omitted -- PUT is a full replacement", async () => {
      const res = await request(app)
        .put("/v1/me/billing")
        .set("Authorization", `Bearer ${userA.accessToken}`)
        .send({ company_name: "Only The Name" });

      expect(res.status).toBe(200);
      expect(res.body.data.billing.company_name).toBe("Only The Name");
      expect(res.body.data.billing.gst_number).toBeNull();
    });

    it("accepts an explicit null to clear a field", async () => {
      const res = await request(app)
        .put("/v1/me/billing")
        .set("Authorization", `Bearer ${userA.accessToken}`)
        .send({ company_name: null, gst_number: VALID_GSTIN });

      expect(res.status).toBe(200);
      expect(res.body.data.billing.company_name).toBeNull();
      expect(res.body.data.billing.gst_number).toBe(VALID_GSTIN);
    });

    it("accepts an entirely empty body -- billing details are optional", async () => {
      const res = await request(app)
        .put("/v1/me/billing")
        .set("Authorization", `Bearer ${userA.accessToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.billing.company_name).toBeNull();
      expect(res.body.data.billing.gst_number).toBeNull();
    });

    it("deletes billing details, and a later read reports none", async () => {
      await request(app)
        .put("/v1/me/billing")
        .set("Authorization", `Bearer ${userA.accessToken}`)
        .send({ company_name: "To Be Removed", gst_number: VALID_GSTIN });

      const del = await request(app).delete("/v1/me/billing").set("Authorization", `Bearer ${userA.accessToken}`);
      expect(del.status).toBe(200);
      expect(del.body.data.billing).toBeNull();

      const get = await request(app).get("/v1/me/billing").set("Authorization", `Bearer ${userA.accessToken}`);
      expect(get.body.data.billing).toBeNull();
    });

    it("treats deleting nothing as a success, so a retry is safe", async () => {
      const first = await request(app).delete("/v1/me/billing").set("Authorization", `Bearer ${userA.accessToken}`);
      const second = await request(app).delete("/v1/me/billing").set("Authorization", `Bearer ${userA.accessToken}`);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
    });

    it("returns only billing fields -- no profile, auth or role data", async () => {
      await request(app)
        .put("/v1/me/billing")
        .set("Authorization", `Bearer ${userA.accessToken}`)
        .send({ company_name: "Eastlight Films", gst_number: VALID_GSTIN });

      const res = await request(app).get("/v1/me/billing").set("Authorization", `Bearer ${userA.accessToken}`);

      expect(Object.keys(res.body.data.billing).sort()).toEqual(
        ["company_name", "created_at", "gst_number", "updated_at", "user_id"].sort()
      );
      expect(res.body.data).not.toHaveProperty("profile");
      expect(res.body.data).not.toHaveProperty("roles");
      expect(JSON.stringify(res.body)).not.toContain(userA.email);
    });
  });

  // ── Validation ────────────────────────────────────────────────────────────

  describe("GST validation", () => {
    it("rejects a malformed GST number", async () => {
      for (const invalid of ["NOT-A-GSTIN", "27AAPFU0939F1Z", "1234567890", "", "27aapfu0939f1z!"]) {
        const res = await request(app)
          .put("/v1/me/billing")
          .set("Authorization", `Bearer ${userA.accessToken}`)
          .send({ gst_number: invalid });

        expect(res.status, `expected ${invalid} to be rejected`).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("rejects a GSTIN whose check digit is wrong", async () => {
      const res = await request(app)
        .put("/v1/me/billing")
        .set("Authorization", `Bearer ${userA.accessToken}`)
        .send({ gst_number: BAD_CHECKSUM_GSTIN });

      expect(res.status).toBe(400);
    });

    it("normalises case and whitespace before storing", async () => {
      const res = await request(app)
        .put("/v1/me/billing")
        .set("Authorization", `Bearer ${userA.accessToken}`)
        .send({ gst_number: " 27aapfu0939f1zv " });

      expect(res.status).toBe(200);
      expect(res.body.data.billing.gst_number).toBe(VALID_GSTIN);
    });

    it("rejects a blank company name rather than treating it as a clear", async () => {
      const res = await request(app)
        .put("/v1/me/billing")
        .set("Authorization", `Bearer ${userA.accessToken}`)
        .send({ company_name: "   " });

      expect(res.status).toBe(400);
    });

    it("rejects unknown fields, so user_id and timestamps are not writable", async () => {
      for (const body of [
        { user_id: userB.id },
        { created_at: "2020-01-01T00:00:00Z" },
        { updated_at: "2020-01-01T00:00:00Z" },
        { company_name: "X", nonsense: true },
      ]) {
        const res = await request(app)
          .put("/v1/me/billing")
          .set("Authorization", `Bearer ${userA.accessToken}`)
          .send(body);

        expect(res.status, `expected ${JSON.stringify(body)} to be rejected`).toBe(400);
      }
    });

    it("validates the checksum algorithm directly", () => {
      expect(hasValidGstinChecksum(VALID_GSTIN)).toBe(true);
      expect(hasValidGstinChecksum(OTHER_VALID_GSTIN)).toBe(true);
      expect(hasValidGstinChecksum("07AAACB2894G1ZP")).toBe(true);
      expect(hasValidGstinChecksum(BAD_CHECKSUM_GSTIN)).toBe(false);
      expect(hasValidGstinChecksum("")).toBe(false);
      expect(hasValidGstinChecksum("27AAPFU0939F1Z")).toBe(false);
    });
  });

  // ── Authorization ─────────────────────────────────────────────────────────

  describe("ownership and RLS", () => {
    it("rejects every route without a token", async () => {
      const get = await request(app).get("/v1/me/billing");
      const put = await request(app).put("/v1/me/billing").send({ company_name: "X" });
      const del = await request(app).delete("/v1/me/billing");

      expect(get.status).toBe(401);
      expect(put.status).toBe(401);
      expect(del.status).toBe(401);
    });

    it("never returns another user's billing details", async () => {
      await request(app)
        .put("/v1/me/billing")
        .set("Authorization", `Bearer ${userA.accessToken}`)
        .send({ company_name: "User A Films", gst_number: VALID_GSTIN });

      const res = await request(app).get("/v1/me/billing").set("Authorization", `Bearer ${userB.accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.billing).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain(VALID_GSTIN);
      expect(JSON.stringify(res.body)).not.toContain("User A Films");
    });

    it("RLS hides another user's row from a direct PostgREST read", async () => {
      const client = userClient(userB.accessToken);
      const { data, error } = await client.from("user_billing_profiles").select("*").eq("user_id", userA.id);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("RLS refuses an insert under another user's id", async () => {
      const client = userClient(userB.accessToken);
      const { error } = await client.from("user_billing_profiles").insert({
        user_id: userA.id,
        company_name: "Impersonation",
      });

      expect(error?.code).toBe("42501"); // insufficient_privilege (RLS with-check)
    });

    it("RLS refuses an update to another user's row", async () => {
      const client = userClient(userB.accessToken);
      const { data, error } = await client
        .from("user_billing_profiles")
        .update({ company_name: "Hijacked" })
        .eq("user_id", userA.id)
        .select();

      // The row is invisible to userB, so the update matches nothing rather than erroring.
      expect(error).toBeNull();
      expect(data).toEqual([]);

      const owner = userClient(userA.accessToken);
      const { data: unchanged } = await owner
        .from("user_billing_profiles")
        .select("company_name")
        .eq("user_id", userA.id)
        .single();
      expect(unchanged!.company_name).toBe("User A Films");
    });

    it("RLS refuses a delete of another user's row", async () => {
      const client = userClient(userB.accessToken);
      await client.from("user_billing_profiles").delete().eq("user_id", userA.id);

      const owner = userClient(userA.accessToken);
      const { data } = await owner.from("user_billing_profiles").select("user_id").eq("user_id", userA.id);
      expect(data).toHaveLength(1);
    });

    it("an admin cannot read another user's billing details (decision D6)", async () => {
      const client = userClient(admin.accessToken);
      const { data, error } = await client.from("user_billing_profiles").select("*").eq("user_id", userA.id);

      expect(error).toBeNull();
      expect(data).toEqual([]);

      const viaApi = await request(app).get("/v1/me/billing").set("Authorization", `Bearer ${admin.accessToken}`);
      expect(viaApi.body.data.billing).toBeNull();
    });

    it("grants nothing to anonymous callers", async () => {
      const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const { data, error } = await anon.from("user_billing_profiles").select("*");
      // Either no grant at all, or RLS yields nothing -- both are acceptable; leaking a row is not.
      expect(error !== null || (data ?? []).length === 0).toBe(true);
      expect(JSON.stringify(data ?? [])).not.toContain(VALID_GSTIN);
    });

    it("removes billing details when the owning auth user is deleted", async () => {
      const doomed = await createTestUser();
      await request(app)
        .put("/v1/me/billing")
        .set("Authorization", `Bearer ${doomed.accessToken}`)
        .send({ company_name: "Ephemeral Films" });

      await deleteTestUser(doomed.id);

      const admin2 = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data } = await admin2.from("user_billing_profiles").select("user_id").eq("user_id", doomed.id);
      expect(data).toEqual([]);
    });
  });
});

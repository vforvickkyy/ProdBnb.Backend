import { SupabaseClient } from "@supabase/supabase-js";
import { PutBillingInput } from "./billing.schema";

/**
 * What `GET /v1/me/billing` returns. Deliberately just the billing facts plus their timestamps —
 * **no profile, auth or role fields are joined in**. A caller asking about billing gets billing.
 */
export interface BillingProfileRow {
  user_id: string;
  company_name: string | null;
  gst_number: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Kept as a single string literal, not a concatenation: supabase-js infers the row type from the
 * literal, and `"a" + "b"` widens it to `string`, collapsing the inferred result to an error type.
 * (Same note as `users.service.ts`'s `PROFILE_COLUMNS`.)
 */
const BILLING_COLUMNS = "user_id, company_name, gst_number, created_at, updated_at";

/**
 * The caller's billing details, or `null` when they have never supplied any.
 *
 * `null` rather than an error: having no billing details is the normal state for most users, not a
 * 404 condition. The endpoint is not "fetch a resource that should exist", it is "tell me what I
 * have", and the honest answer for a new user is "nothing".
 *
 * Runs on the caller's own RLS-scoped client, so `user_billing_profiles_select_own` — not this
 * function — is what guarantees one user can never read another's row.
 */
export async function getBillingProfile(
  supabase: SupabaseClient,
  userId: string
): Promise<BillingProfileRow | null> {
  const { data, error } = await supabase
    .from("user_billing_profiles")
    .select(BILLING_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ?? null;
}

/**
 * Creates or replaces the caller's billing details.
 *
 * `upsert` on the primary key is what makes this idempotent and what makes "one row per user" hold
 * without a read-then-write race: two concurrent PUTs resolve to one row, decided by Postgres,
 * rather than one of them failing on a unique violation.
 *
 * `user_id` is taken from the **session**, never from the request body — `putBillingSchema` is
 * `.strict()` and does not even accept the key. Combined with the policy's `with check`, a caller
 * cannot write a row under another user's id even if they try.
 *
 * An omitted field clears that value, which is the documented meaning of this full-replacement
 * endpoint (see `putBillingSchema`).
 */
export async function putBillingProfile(
  supabase: SupabaseClient,
  userId: string,
  input: PutBillingInput
): Promise<BillingProfileRow> {
  const { data, error } = await supabase
    .from("user_billing_profiles")
    .upsert(
      {
        user_id: userId,
        company_name: input.company_name ?? null,
        gst_number: input.gst_number ?? null,
      },
      { onConflict: "user_id" }
    )
    .select(BILLING_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Removes the caller's billing details entirely.
 *
 * Deleting the row rather than nulling its columns: it makes "has this user supplied anything?" a
 * single existence check, and it leaves nothing behind that a future admin read could surface.
 *
 * Idempotent — deleting when there is nothing to delete is a success, not a 404. A client clearing
 * details should not have to know whether a row existed first, and a retry after a dropped response
 * must not fail.
 */
export async function deleteBillingProfile(supabase: SupabaseClient, userId: string): Promise<void> {
  const { error } = await supabase.from("user_billing_profiles").delete().eq("user_id", userId);

  if (error) {
    throw error;
  }
}

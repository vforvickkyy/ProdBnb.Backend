import { ConflictError, NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { writeAuditLog } from "../admin/audit.service";
import { AdminDeletionRequestsQuery } from "./account.schema";

/**
 * Account deletion (booker account). The user asks; an admin completes it.
 *
 * Completing never deletes rows: bookings and payments cascade from `profiles` and must be kept for
 * tax and disputes. Instead the profile is anonymised, its contact and billing details removed,
 * devices unregistered, any listings archived, and sign-in locked by moving the login to an
 * unusable address and banning it. The person's original email is then free to sign up afresh.
 */

export type DeletionStatus = "pending" | "completed" | "declined" | "withdrawn";

export interface DeletionRequest {
  id: string;
  user_id: string;
  reason: string | null;
  status: DeletionStatus;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = "id, user_id, reason, status, decided_at, decision_note, created_at, updated_at";
const ACTIVE_BOOKING_STATUSES = ["requested", "confirmed"];

export interface DeletionBlockers {
  /** Upcoming bookings this person made. */
  upcoming_bookings: number;
  /** Upcoming bookings other people made at this person's listings. */
  upcoming_hosted_bookings: number;
}

export async function deletionBlockers(userId: string): Promise<DeletionBlockers> {
  const now = new Date().toISOString();
  const [{ count: mine, error: e1 }, { data: listings, error: e2 }] = await Promise.all([
    adminClient
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("booker_id", userId)
      .in("status", ACTIVE_BOOKING_STATUSES)
      .gt("end_at", now),
    adminClient.from("locations").select("id").eq("host_id", userId),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  let hosted = 0;
  const ids = (listings ?? []).map((l) => l.id as string);
  if (ids.length > 0) {
    const { count, error } = await adminClient
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .in("location_id", ids)
      .in("status", ACTIVE_BOOKING_STATUSES)
      .gt("end_at", now);
    if (error) throw error;
    hosted = count ?? 0;
  }
  return { upcoming_bookings: mine ?? 0, upcoming_hosted_bookings: hosted };
}

function assertNoBlockers(blockers: DeletionBlockers, who: "you" | "they"): void {
  if (blockers.upcoming_bookings > 0 || blockers.upcoming_hosted_bookings > 0) {
    const parts = [
      blockers.upcoming_bookings > 0 ? `${blockers.upcoming_bookings} upcoming booking${blockers.upcoming_bookings === 1 ? "" : "s"}` : null,
      blockers.upcoming_hosted_bookings > 0
        ? `${blockers.upcoming_hosted_bookings} upcoming booking${blockers.upcoming_hosted_bookings === 1 ? "" : "s"} at ${who === "you" ? "your" : "their"} listings`
        : null,
    ].filter(Boolean);
    throw new ConflictError(
      `${who === "you" ? "You have" : "They have"} ${parts.join(" and ")}. ${who === "you" ? "Cancel or complete them" : "These must be cancelled or completed"} before the account can be deleted.`
    );
  }
}

export async function getMyDeletionRequest(userId: string): Promise<DeletionRequest | null> {
  const { data, error } = await adminClient
    .from("account_deletion_requests")
    .select(COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as DeletionRequest | null) ?? null;
}

export async function requestDeletion(userId: string, reason: string | null): Promise<DeletionRequest> {
  assertNoBlockers(await deletionBlockers(userId), "you");
  const { data, error } = await adminClient
    .from("account_deletion_requests")
    .insert({ user_id: userId, reason })
    .select(COLUMNS)
    .single();
  if (error?.code === "23505") throw new ConflictError("You've already asked to delete your account. Our team is on it.");
  if (error) throw error;
  return data as DeletionRequest;
}

export async function withdrawDeletion(userId: string): Promise<DeletionRequest> {
  const { data, error } = await adminClient
    .from("account_deletion_requests")
    .update({ status: "withdrawn" })
    .eq("user_id", userId)
    .eq("status", "pending")
    .is("decided_at", null)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ValidationError("There is no pending deletion request to cancel.");
  return data as DeletionRequest;
}

// Admin -----------------------------------------------------------------------------------------

export interface AdminDeletionRequest extends DeletionRequest {
  user: { id: string; first_name: string | null; last_name: string | null; status: string } | null;
  email: string | null;
  blockers: DeletionBlockers | null;
}

export async function listAdminDeletionRequests(query: AdminDeletionRequestsQuery): Promise<{ data: AdminDeletionRequest[]; total: number }> {
  const from = (query.page - 1) * query.pageSize;
  let q = adminClient
    .from("account_deletion_requests")
    .select(`${COLUMNS}, user:profiles!user_id(id, first_name, last_name, status)`, { count: "exact" })
    .order("created_at", { ascending: query.status === "pending" })
    .range(from, from + query.pageSize - 1);
  if (query.status) q = q.eq("status", query.status);
  const { data, error, count } = await q;
  if (error) throw error;
  const rows = (data ?? []) as unknown as Omit<AdminDeletionRequest, "email" | "blockers">[];
  const enriched = await Promise.all(
    rows.map(async (row) => {
      const [{ data: auth }, blockers] = await Promise.all([
        adminClient.auth.admin.getUserById(row.user_id),
        row.status === "pending" ? deletionBlockers(row.user_id) : Promise.resolve(null),
      ]);
      return { ...row, email: auth?.user?.email ?? null, blockers };
    })
  );
  return { data: enriched, total: count ?? enriched.length };
}

async function claim(requestId: string, adminId: string): Promise<DeletionRequest> {
  const { data, error } = await adminClient
    .from("account_deletion_requests")
    .update({ decided_by: adminId, decided_at: new Date().toISOString() })
    .eq("id", requestId)
    .eq("status", "pending")
    .is("decided_at", null)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const { data: exists } = await adminClient.from("account_deletion_requests").select("id, status").eq("id", requestId).maybeSingle();
    if (!exists) throw new NotFoundError("Deletion request not found.");
    throw new ConflictError(exists.status === "pending" ? "Another admin is deciding this request." : "This request has already been decided.");
  }
  return data as DeletionRequest;
}

async function release(requestId: string): Promise<void> {
  await adminClient.from("account_deletion_requests").update({ decided_by: null, decided_at: null }).eq("id", requestId).eq("status", "pending");
}

/** Anonymise and lock. Every step is idempotent, so a retry after a partial failure finishes the job. */
async function anonymise(userId: string): Promise<{ archived_location_ids: string[] }> {
  const { error: profileError } = await adminClient
    .from("profiles")
    .update({
      first_name: "Deleted",
      last_name: "user",
      avatar_url: null,
      phone: null,
      address_line1: null,
      address_line2: null,
      address_city: null,
      address_region: null,
      address_country: null,
      address_postal_code: null,
      status: "deleted",
    })
    .eq("id", userId);
  if (profileError) throw profileError;

  for (const table of ["user_billing_profiles", "user_devices"]) {
    const { error } = await adminClient.from(table).delete().eq("user_id", userId);
    if (error) throw error;
  }

  const { data: listings, error: listingsError } = await adminClient
    .from("locations")
    .update({ status: "archived", moderation_reason: "Host account deleted." })
    .eq("host_id", userId)
    .neq("status", "archived")
    .select("id");
  if (listingsError) throw listingsError;

  const { error: authError } = await adminClient.auth.admin.updateUserById(userId, {
    email: `deleted+${userId}@deleted.invalid`,
    email_confirm: true,
    user_metadata: {},
    ban_duration: "876000h",
  });
  if (authError) throw authError;

  return { archived_location_ids: (listings ?? []).map((l) => l.id as string) };
}

export async function completeDeletion(adminId: string, requestId: string, note: string | null): Promise<DeletionRequest> {
  const request = await claim(requestId, adminId);
  let archived: string[];
  try {
    assertNoBlockers(await deletionBlockers(request.user_id), "they");
    archived = (await anonymise(request.user_id)).archived_location_ids;
  } catch (err) {
    await release(requestId);
    throw err;
  }
  const { data, error } = await adminClient
    .from("account_deletion_requests")
    .update({ status: "completed", decision_note: note })
    .eq("id", requestId)
    .select(COLUMNS)
    .single();
  if (error) throw error;
  await writeAuditLog(adminId, "ADMIN_COMPLETED_ACCOUNT_DELETION", "deletion_request", requestId, note, {
    user_id: request.user_id,
    archived_location_ids: archived,
  });
  return data as DeletionRequest;
}

export async function declineDeletion(adminId: string, requestId: string, note: string): Promise<DeletionRequest> {
  const request = await claim(requestId, adminId);
  const { data, error } = await adminClient
    .from("account_deletion_requests")
    .update({ status: "declined", decision_note: note })
    .eq("id", requestId)
    .select(COLUMNS)
    .single();
  if (error) {
    await release(requestId);
    throw error;
  }
  await writeAuditLog(adminId, "ADMIN_DECLINED_ACCOUNT_DELETION", "deletion_request", requestId, note, { user_id: request.user_id });
  return data as DeletionRequest;
}

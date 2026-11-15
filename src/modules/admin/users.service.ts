import { SupabaseClient } from "@supabase/supabase-js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { AdminProfileRow } from "../users/users.service";
import { writeAuditLog } from "./audit.service";

export interface AdminUserDetail extends AdminProfileRow {
  email: string | null;
  last_sign_in_at: string | null;
  locations_count: number;
  bookings_count: number;
  /** Admin Console: the user's admin team role, or null when they are not an admin. */
  team_role: string | null;
  /** Admin Console: contact details and GST billing details, for support and invoicing. */
  contact: {
    phone: string | null;
    address_line1: string | null;
    address_line2: string | null;
    address_city: string | null;
    address_region: string | null;
    address_country: string | null;
    address_postal_code: string | null;
  };
  billing: { company_name: string | null; gst_number: string | null; updated_at: string } | null;
}

/**
 * `profiles` deliberately has no email column (Phase 1: "Auth credentials
 * stay in auth.users"). Email/last-sign-in can only come from Supabase's
 * Admin Auth API, which is why this one read needs `adminClient` even
 * though every other admin read in this module uses the caller's own
 * request-scoped client where RLS already covers it.
 */
export async function getAdminUserDetail(supabase: SupabaseClient, userId: string): Promise<AdminUserDetail> {
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, first_name, last_name, avatar_url, status, created_at, updated_at, user_roles ( role )")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!profile) {
    throw new NotFoundError("User not found.");
  }

  const { user_roles, ...rest } = profile as typeof profile & { user_roles: { role: string }[] };

  // Contact columns are on `profiles` but outside the admin list select; billing has no admin RLS
  // arm (user_billing_profiles is own-row only), and the team table is the authority on team
  // roles -- all three read through adminClient after the route's users.view permission check.
  const [{ data: authUser }, locationsCount, bookingsCount, contactResult, billingResult, teamResult] = await Promise.all([
    adminClient.auth.admin.getUserById(userId),
    supabase.from("locations").select("id", { count: "exact", head: true }).eq("host_id", userId),
    supabase.from("bookings").select("id", { count: "exact", head: true }).eq("booker_id", userId),
    adminClient
      .from("profiles")
      .select("phone, address_line1, address_line2, address_city, address_region, address_country, address_postal_code")
      .eq("id", userId)
      .maybeSingle(),
    adminClient.from("user_billing_profiles").select("company_name, gst_number, updated_at").eq("user_id", userId).maybeSingle(),
    adminClient.from("admin_team_members").select("team_role").eq("user_id", userId).maybeSingle(),
  ]);
  for (const result of [contactResult, billingResult, teamResult]) {
    if (result.error) {
      throw result.error;
    }
  }

  const contact = contactResult.data ?? {
    phone: null,
    address_line1: null,
    address_line2: null,
    address_city: null,
    address_region: null,
    address_country: null,
    address_postal_code: null,
  };

  return {
    ...rest,
    roles: user_roles.map((r) => r.role),
    email: authUser.user?.email ?? null,
    last_sign_in_at: authUser.user?.last_sign_in_at ?? null,
    locations_count: locationsCount.count ?? 0,
    bookings_count: bookingsCount.count ?? 0,
    team_role: (teamResult.data?.team_role as string | undefined) ?? null,
    contact,
    billing: billingResult.data ?? null,
  };
}

/**
 * Admin Console: grant a booker/host role on someone's behalf (e.g. onboarding a host by hand).
 * `admin` is never grantable here -- that is the team API (super_admin only). Service-role write:
 * since the team-roles migration, no admin can write another user's roles through PostgREST.
 */
export async function grantUserRole(adminId: string, userId: string, role: "booker" | "host"): Promise<AdminUserDetail> {
  const { error } = await adminClient.from("user_roles").insert({ user_id: userId, role });
  if (error) {
    if (error.code === "23505") {
      throw new ConflictError(`This user already has the ${role} role.`);
    }
    if (error.code === "23503") {
      throw new NotFoundError("User not found.");
    }
    throw error;
  }
  await writeAuditLog(adminId, "ADMIN_GRANTED_ROLE", "user", userId, null, { role });
  return getAdminUserDetail(adminClient, userId);
}

/** Removing `host` does not touch their listings -- it only stops them creating new ones. */
export async function revokeUserRole(adminId: string, userId: string, role: "booker" | "host"): Promise<AdminUserDetail> {
  const { data, error } = await adminClient.from("user_roles").delete().eq("user_id", userId).eq("role", role).select("id");
  if (error) {
    throw error;
  }
  if (!data || data.length === 0) {
    throw new NotFoundError(`This user does not have the ${role} role.`);
  }
  await writeAuditLog(adminId, "ADMIN_REVOKED_ROLE", "user", userId, null, { role });
  return getAdminUserDetail(adminClient, userId);
}

/**
 * Admin Console: suspending a fellow administrator is a team decision, not a moderation one.
 * Only a super admin (team.manage) may do it, and nobody may suspend themselves -- a suspended
 * account cannot reach the API to undo it.
 */
export async function assertMaySuspend(adminId: string, userId: string, actorCanManageTeam: boolean): Promise<void> {
  if (adminId === userId) {
    throw new ValidationError("You cannot suspend your own account.");
  }
  const { data, error } = await adminClient.from("admin_team_members").select("team_role").eq("user_id", userId).maybeSingle();
  if (error) {
    throw error;
  }
  if (data && !actorCanManageTeam) {
    throw new ForbiddenError("Only a super admin can suspend another admin.");
  }
}

async function getProfileStatus(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await supabase.from("profiles").select("status").eq("id", userId).maybeSingle();
  if (error) {
    throw error;
  }
  return data?.status ?? null;
}

/**
 * `profiles.status` has no column-level UPDATE grant to `authenticated` at
 * all (Phase 1: "so profile updates can never self-escalate account
 * status") -- only `service_role` can write it, for any user including an
 * admin's own row. This is why suspend/restore must use `adminClient`, not
 * the caller's own scoped client, unlike most other admin writes in this
 * module.
 *
 * Cascades to the host's currently-`published` locations only (never
 * touches draft/submitted/independently-suspended/rejected/archived ones),
 * marking each with `suspended_by_host_suspension = true` so a later
 * restore can tell them apart from an independent admin decision. Existing
 * bookings, payments, and availability are never touched.
 */
export async function suspendUser(
  supabase: SupabaseClient,
  adminId: string,
  userId: string,
  reason: string
): Promise<AdminUserDetail> {
  const status = await getProfileStatus(supabase, userId);
  if (!status) {
    throw new NotFoundError("User not found.");
  }
  if (status === "suspended") {
    throw new ValidationError("User is already suspended.");
  }

  const { error: statusError } = await adminClient.from("profiles").update({ status: "suspended" }).eq("id", userId);
  if (statusError) {
    throw statusError;
  }

  const { data: locations, error: locationsError } = await adminClient
    .from("locations")
    .select("id")
    .eq("host_id", userId)
    .eq("status", "published");
  if (locationsError) {
    throw locationsError;
  }

  const locationIds = (locations ?? []).map((l) => l.id as string);
  if (locationIds.length > 0) {
    const { error: cascadeError } = await adminClient
      .from("locations")
      .update({
        status: "suspended",
        moderation_reason: "Host account suspended.",
        suspended_by_host_suspension: true,
      })
      .in("id", locationIds);
    if (cascadeError) {
      throw cascadeError;
    }
  }

  await writeAuditLog(adminId, "ADMIN_SUSPENDED_USER", "user", userId, reason, { suspended_location_ids: locationIds });
  return getAdminUserDetail(supabase, userId);
}

/** Only republishes locations this user's own suspension put down (see the migration's column comment) -- never an independently-moderated one. */
export async function restoreUser(supabase: SupabaseClient, adminId: string, userId: string): Promise<AdminUserDetail> {
  const status = await getProfileStatus(supabase, userId);
  if (!status) {
    throw new NotFoundError("User not found.");
  }
  if (status !== "suspended") {
    throw new ValidationError("User is not suspended.");
  }

  const { error: statusError } = await adminClient.from("profiles").update({ status: "active" }).eq("id", userId);
  if (statusError) {
    throw statusError;
  }

  const { data: locations, error: locationsError } = await adminClient
    .from("locations")
    .select("id")
    .eq("host_id", userId)
    .eq("status", "suspended")
    .eq("suspended_by_host_suspension", true);
  if (locationsError) {
    throw locationsError;
  }

  const locationIds = (locations ?? []).map((l) => l.id as string);
  if (locationIds.length > 0) {
    const { error: cascadeError } = await adminClient
      .from("locations")
      .update({ status: "published", moderation_reason: null, suspended_by_host_suspension: false })
      .in("id", locationIds);
    if (cascadeError) {
      throw cascadeError;
    }
  }

  await writeAuditLog(adminId, "ADMIN_RESTORED_USER", "user", userId, null, { restored_location_ids: locationIds });
  return getAdminUserDetail(supabase, userId);
}

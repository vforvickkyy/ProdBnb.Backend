import { NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { createLocation, getLocation, LocationDetail } from "../locations/locations.service";
import { writeAuditLog } from "./audit.service";
import { AdminCreateLocationInput, HostSearchQuery } from "./admin.schema";

/**
 * Admin Console 2: create a listing ON BEHALF OF a host.
 *
 * The listing belongs to the host from the first moment -- `host_id` is theirs, so they see it in
 * their app and manage it exactly like one they made themselves. The admin is recorded only in the
 * audit log (ADMIN_CREATED_LOCATION), never as an owner.
 *
 * Rules:
 *  - the host account must exist and be active (not suspended/deleted);
 *  - it must hold the `host` role. If it does not, the admin can pass `grant_host_role: true` to
 *    grant it in the same step (audited separately as ADMIN_GRANTED_ROLE) -- otherwise 422, so an
 *    admin cannot silently turn a booker into a host;
 *  - the listing starts as `draft` (default) or `published`. Publishing on create skips the review
 *    queue, which is the point: an admin creating it IS the review.
 */
export async function createLocationForHost(actorId: string, input: AdminCreateLocationInput): Promise<LocationDetail> {
  const { host_id: hostId, grant_host_role: grantHostRole, status, ...fields } = input;

  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, status")
    .eq("id", hostId)
    .maybeSingle();
  if (profileError) {
    throw profileError;
  }
  if (!profile) {
    throw new NotFoundError("Host account not found.");
  }
  if (profile.status !== "active") {
    throw new ValidationError(`This account is ${profile.status as string}; a listing cannot be created for it.`);
  }

  const { data: role, error: roleError } = await adminClient
    .from("user_roles")
    .select("id")
    .eq("user_id", hostId)
    .eq("role", "host")
    .maybeSingle();
  if (roleError) {
    throw roleError;
  }
  if (!role) {
    if (!grantHostRole) {
      throw new ValidationError(
        "This account does not have the host role. Tick 'Make this person a host' to grant it while creating the listing."
      );
    }
    const { error: grantError } = await adminClient.from("user_roles").insert({ user_id: hostId, role: "host" });
    if (grantError && grantError.code !== "23505") {
      throw grantError;
    }
    await writeAuditLog(actorId, "ADMIN_GRANTED_ROLE", "user", hostId, "Granted while creating a listing for them.", {
      role: "host",
    });
  }

  const created = await createLocation(adminClient, hostId, fields);

  if (status === "published") {
    const { error } = await adminClient
      .from("locations")
      .update({ status: "published", moderation_reason: null })
      .eq("id", created.id);
    if (error) {
      throw error;
    }
  }

  await writeAuditLog(actorId, "ADMIN_CREATED_LOCATION", "location", created.id, null, {
    host_id: hostId,
    status,
    granted_host_role: !role,
  });

  return getLocation(adminClient, created.id, { userId: actorId, isAdmin: true });
}

export interface HostCandidate {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  status: string;
  is_host: boolean;
  location_count: number;
}

/**
 * The host picker behind "New listing": accounts matching a name or email, hosts first. Includes
 * non-hosts on purpose (flagged `is_host: false`) so an admin can find the person and grant the
 * role in the same step.
 */
export async function searchHostCandidates(query: HostSearchQuery): Promise<HostCandidate[]> {
  const term = query.search.trim();
  const { data: users, error } = await adminClient.rpc("admin_search_users", { _term: term, _limit: query.limit });
  if (error) {
    throw error;
  }
  const rows = (users ?? []) as { id: string; first_name: string | null; last_name: string | null; email: string | null; status: string }[];
  if (rows.length === 0) {
    return [];
  }

  const ids = rows.map((r) => r.id);
  const [rolesResult, locationsResult] = await Promise.all([
    adminClient.from("user_roles").select("user_id").eq("role", "host").in("user_id", ids),
    adminClient.from("locations").select("host_id").in("host_id", ids),
  ]);
  if (rolesResult.error) {
    throw rolesResult.error;
  }
  if (locationsResult.error) {
    throw locationsResult.error;
  }
  const hosts = new Set((rolesResult.data ?? []).map((r) => r.user_id as string));
  const counts = new Map<string, number>();
  for (const l of locationsResult.data ?? []) {
    counts.set(l.host_id as string, (counts.get(l.host_id as string) ?? 0) + 1);
  }

  return rows
    .map((r) => ({ ...r, is_host: hosts.has(r.id), location_count: counts.get(r.id) ?? 0 }))
    .filter((r) => !query.hosts_only || r.is_host)
    .sort((a, b) => Number(b.is_host) - Number(a.is_host));
}

import { ConflictError, NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { writeAuditLog } from "./audit.service";
import { AdminPermission, permissionsFor, TeamRole } from "./permissions";
import { env } from "../../config/env";

export interface TeamMember {
  user_id: string;
  team_role: TeamRole;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  status: string;
  email: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminMe {
  user_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  team_role: TeamRole;
  permissions: readonly AdminPermission[];
}

interface RawTeamRow {
  user_id: string;
  team_role: TeamRole;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  profile: { first_name: string | null; last_name: string | null; avatar_url: string | null; status: string } | null;
}

const TEAM_SELECT =
  "user_id, team_role, created_by, created_at, updated_at, profile:profiles!admin_team_members_user_id_fkey ( first_name, last_name, avatar_url, status )";

async function emailFor(userId: string): Promise<string | null> {
  const { data, error } = await adminClient.auth.admin.getUserById(userId);
  if (error) {
    return null;
  }
  return data.user?.email ?? null;
}

function toMember(row: RawTeamRow, email: string | null): TeamMember {
  return {
    user_id: row.user_id,
    team_role: row.team_role,
    first_name: row.profile?.first_name ?? null,
    last_name: row.profile?.last_name ?? null,
    avatar_url: row.profile?.avatar_url ?? null,
    status: row.profile?.status ?? "active",
    email,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** The whole team. Small by nature (a handful of people), so one email lookup per member is fine. */
export async function listTeam(): Promise<TeamMember[]> {
  const { data, error } = await adminClient.from("admin_team_members").select(TEAM_SELECT).order("created_at", { ascending: true });
  if (error) {
    throw error;
  }
  const rows = (data ?? []) as unknown as RawTeamRow[];
  const emails = await Promise.all(rows.map((row) => emailFor(row.user_id)));
  return rows.map((row, index) => toMember(row, emails[index] ?? null));
}

async function getMember(userId: string): Promise<TeamMember> {
  const { data, error } = await adminClient.from("admin_team_members").select(TEAM_SELECT).eq("user_id", userId).maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("That user is not on the admin team.");
  }
  return toMember(data as unknown as RawTeamRow, await emailFor(userId));
}

export async function getAdminMe(userId: string, email: string | null, teamRole: TeamRole): Promise<AdminMe> {
  const { data, error } = await adminClient.from("profiles").select("first_name, last_name").eq("id", userId).maybeSingle();
  if (error) {
    throw error;
  }
  return {
    user_id: userId,
    email,
    first_name: data?.first_name ?? null,
    last_name: data?.last_name ?? null,
    team_role: teamRole,
    permissions: permissionsFor(teamRole),
  };
}

/** Postgres raises these from admin_set_team_member()/admin_remove_team_member(). */
function translateTeamError(error: { message?: string; code?: string }): never {
  const message = error.message ?? "";
  if (message.includes("last_super_admin")) {
    throw new ConflictError("The platform must always keep at least one super admin.");
  }
  if (message.includes("not_a_team_member")) {
    throw new NotFoundError("That user is not on the admin team.");
  }
  if (message.includes("invalid_team_role")) {
    throw new ValidationError("Unknown team role.");
  }
  throw error;
}

/**
 * Makes `userId` an admin with `teamRole`, or changes their team role. Atomic (one SQL function,
 * one advisory lock) and guarded so the last super admin can never be demoted. Audited.
 */
export async function setTeamMember(actorId: string, userId: string, teamRole: TeamRole): Promise<TeamMember> {
  const { data: profile, error: profileError } = await adminClient.from("profiles").select("id, status").eq("id", userId).maybeSingle();
  if (profileError) {
    throw profileError;
  }
  if (!profile) {
    throw new NotFoundError("User not found.");
  }
  if (profile.status !== "active") {
    throw new ValidationError("A suspended account cannot be given an admin role. Restore it first.");
  }

  const { data: previous, error } = await adminClient.rpc("admin_set_team_member", {
    _user_id: userId,
    _team_role: teamRole,
    _actor_id: actorId,
  });
  if (error) {
    translateTeamError(error);
  }

  await writeAuditLog(actorId, "ADMIN_SET_TEAM_ROLE", "user", userId, null, {
    previous_team_role: (previous as string | null) ?? null,
    new_team_role: teamRole,
  });
  return getMember(userId);
}

/** Adds by email -- the account must already exist (they sign up in any of the platform's apps first). */
export async function addTeamMemberByEmail(actorId: string, email: string, teamRole: TeamRole): Promise<TeamMember> {
  const { data: userId, error } = await adminClient.rpc("admin_find_user_id_by_email", { _email: email });
  if (error) {
    throw error;
  }
  if (!userId) {
    throw new NotFoundError(`No ${env.BRAND_NAME} account uses that email. Ask them to sign up first, then add them.`);
  }
  return setTeamMember(actorId, userId as string, teamRole);
}

/** Removes someone from the team entirely (they keep their booker/host roles). Audited. */
export async function removeTeamMember(actorId: string, userId: string): Promise<void> {
  if (actorId === userId) {
    throw new ValidationError("You cannot remove yourself from the admin team. Ask another super admin.");
  }
  const { data: previous, error } = await adminClient.rpc("admin_remove_team_member", { _user_id: userId });
  if (error) {
    translateTeamError(error);
  }
  await writeAuditLog(actorId, "ADMIN_REMOVED_TEAM_MEMBER", "user", userId, null, {
    previous_team_role: (previous as string | null) ?? null,
  });
}

/** Whether `userId` is on the admin team -- used to stop a non-super-admin suspending a colleague. */
export async function isTeamMember(userId: string): Promise<boolean> {
  const { data, error } = await adminClient.from("admin_team_members").select("user_id").eq("user_id", userId).maybeSingle();
  if (error) {
    throw error;
  }
  return data !== null;
}

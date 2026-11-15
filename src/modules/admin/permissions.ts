import { NextFunction, Request, Response } from "express";
import { ForbiddenError, UnauthenticatedError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";

/**
 * Admin team roles (Admin Console). Every admin holds exactly one -- see the
 * `admin_team_members` migration (20261115100000_admin_team_roles.sql).
 *
 * `user_roles.role = 'admin'` is still the platform-level "is an administrator" fact every RLS
 * policy reads; the team role refines WHICH /v1/admin/* powers that administrator holds. This file
 * is the single source of truth for that mapping -- the Admin Panel reads it back through
 * `GET /v1/admin/me` rather than keeping its own copy.
 */
export const TEAM_ROLES = ["super_admin", "moderator", "support", "finance"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const ADMIN_PERMISSIONS = [
  "dashboard.view",
  "analytics.view",
  "users.view",
  "users.manage",
  "locations.view",
  "locations.moderate",
  "catalog.manage",
  "bookings.view",
  "bookings.manage",
  "payments.view",
  "payments.verify",
  "payments.refund",
  "messages.access",
  "notifications.diagnostics",
  "audit.view",
  "team.manage",
  "settings.view",
  "settings.manage",
  "system.view",
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

/**
 * Everyone on the team can SEE the core operational picture (dashboard, users, listings, bookings,
 * audit log, settings) -- the same "accountability across the whole admin team" reasoning the audit
 * log has used since Phase 11. Powers that change something, touch money, or open private
 * correspondence are split by job:
 *
 *  - moderator  -- listings and people: approve/reject/suspend, photos/sections, catalog, user roles
 *  - support    -- bookings and disputes: booking actions, re-checking payments, private messages
 *  - finance    -- money: payments, refunds, analytics
 *  - super_admin -- everything, plus the team, platform settings and integrations
 */
const BASE: readonly AdminPermission[] = [
  "dashboard.view",
  "users.view",
  "locations.view",
  "bookings.view",
  "audit.view",
  "settings.view",
];

export const ROLE_PERMISSIONS: Record<TeamRole, readonly AdminPermission[]> = {
  super_admin: ADMIN_PERMISSIONS,
  moderator: [...BASE, "users.manage", "locations.moderate", "catalog.manage"],
  support: [...BASE, "bookings.manage", "payments.view", "payments.verify", "messages.access", "notifications.diagnostics"],
  finance: [...BASE, "analytics.view", "payments.view", "payments.verify", "payments.refund"],
};

export function permissionsFor(role: TeamRole): readonly AdminPermission[] {
  return ROLE_PERMISSIONS[role];
}

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === "string" && (TEAM_ROLES as readonly string[]).includes(value);
}

/**
 * The caller's team role, or `null` when they are not an administrator at all.
 *
 * Read with the service-role client: this is an authorization input, so it must give the same
 * answer regardless of what the caller's own RLS would show them. Memoised on the request so a
 * handler that asks twice costs one query.
 */
export async function getCallerTeamRole(req: Request): Promise<TeamRole | null> {
  if (!req.user) {
    return null;
  }
  if (req.adminTeamRole !== undefined) {
    return req.adminTeamRole;
  }

  const { data, error } = await adminClient
    .from("admin_team_members")
    .select("team_role")
    .eq("user_id", req.user.id)
    .maybeSingle();
  if (error) {
    throw error;
  }

  const role = isTeamRole(data?.team_role) ? data.team_role : null;
  req.adminTeamRole = role;
  return role;
}

/**
 * Whether the caller is an administrator holding `permission`.
 *
 * This replaces the old "is the caller an admin" checks on the shared, pre-Admin-Console routes
 * (PATCH /v1/locations/:id, POST /v1/bookings/:id/cancel, POST /v1/payments/:id/refunds, media,
 * sections, pricing, availability). Without it a Support admin could still refund through the
 * generic refund route even though the Admin API refuses them -- the gate has to be the same on
 * every door, not just the front one.
 */
export async function callerHasAdminPermission(req: Request, permission: AdminPermission): Promise<boolean> {
  const role = await getCallerTeamRole(req);
  return role !== null && ROLE_PERMISSIONS[role].includes(permission);
}

/** Route guard for /v1/admin/*. Must run after requireAuth + requireRole("admin"). */
export function requirePermission(permission: AdminPermission) {
  return async function (req: Request, _res: Response, next: NextFunction): Promise<void> {
    if (!req.user) {
      throw new UnauthenticatedError();
    }
    const role = await getCallerTeamRole(req);
    if (role === null) {
      throw new ForbiddenError("This action requires an admin team role.");
    }
    if (!ROLE_PERMISSIONS[role].includes(permission)) {
      throw new ForbiddenError(`Your admin role (${role}) does not include '${permission}'.`);
    }
    next();
  };
}

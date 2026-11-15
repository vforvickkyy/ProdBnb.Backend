import { SupabaseClient } from "@supabase/supabase-js";
import { Request } from "express";
import { adminClient } from "../../lib/supabase";
import { z } from "zod";
import { AuditLogQuery, auditActionSchema, auditTargetTypeSchema } from "./admin.schema";
import { callerHasAdminPermission } from "./permissions";

/** The closed vocabulary, mirrored 1:1 by admin_audit_log's CHECK constraints. */
export type AuditAction = z.infer<typeof auditActionSchema>;
export type AuditTargetType = z.infer<typeof auditTargetTypeSchema>;

export interface AuditLogEntry {
  id: string;
  admin_id: string;
  action: AuditAction;
  target_type: AuditTargetType;
  target_id: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

const AUDIT_COLUMNS = "id, admin_id, action, target_type, target_id, reason, metadata, created_at";

/**
 * Writes exactly one audit entry, as the LAST step of a successful
 * privileged mutation. Uses the service-role client -- there is no
 * client-writable path to this table at all (see the Phase 11 migration's
 * RLS: no INSERT grant to `authenticated`), so this function is the only
 * way an entry is ever created, by any admin, for any reason.
 *
 * Deliberately not swallowed on failure the way a notification failure is
 * (src/modules/notifications/notification.service.ts): an audit entry is a
 * compliance record, not a best-effort side effect. A failure here surfaces
 * as a 500 to the caller so it's never silently lost -- but it never
 * reverses the already-committed action that preceded it either.
 */
export async function writeAuditLog(
  adminId: string,
  action: AuditAction,
  targetType: AuditTargetType,
  targetId: string,
  reason?: string | null,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const { error } = await adminClient.from("admin_audit_log").insert({
    admin_id: adminId,
    action,
    target_type: targetType,
    target_id: targetId,
    reason: reason ?? null,
    metadata,
  });
  if (error) {
    throw error;
  }
}

export interface PaginatedAuditLog {
  data: AuditLogEntry[];
  total: number;
}

/**
 * RLS-scoped read (every admin sees every entry, via the
 * admin_audit_log_select_admin_only policy) -- uses the caller's own
 * request-scoped client, not adminClient, since reads don't need to bypass
 * RLS here.
 */
export async function listAuditLog(supabase: SupabaseClient, query: AuditLogQuery): Promise<PaginatedAuditLog> {
  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  let request = supabase.from("admin_audit_log").select(AUDIT_COLUMNS, { count: "exact" });
  if (query.target_type) {
    request = request.eq("target_type", query.target_type);
  }
  if (query.target_id) {
    request = request.eq("target_id", query.target_id);
  }
  if (query.admin_id) {
    request = request.eq("admin_id", query.admin_id);
  }
  if (query.action) {
    request = request.eq("action", query.action);
  }
  if (query.created_after) {
    request = request.gte("created_at", query.created_after);
  }
  if (query.created_before) {
    request = request.lte("created_at", query.created_before);
  }

  const { data, error, count } = await request.order("created_at", { ascending: false }).range(from, to);
  if (error) {
    throw error;
  }

  return { data: (data ?? []) as AuditLogEntry[], total: count ?? 0 };
}

/**
 * Admin Console 2: an administrator changing SOMEONE ELSE'S listing through the shared listing
 * endpoints (photos, pricing, timings, sections) -- the same doors a host uses for their own
 * listing. A host editing their own listing is ordinary product use and is not audited; an admin
 * doing it on a host's behalf is an admin action and is.
 *
 * Best-effort by design: it runs after the change has already succeeded, so a failed audit insert
 * is logged loudly rather than reported to the caller as a failure of a change that did happen.
 */
export async function auditAdminListingEdit(
  req: Request,
  locationId: string,
  action: AuditAction,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  try {
    if (!req.user || !(await callerHasAdminPermission(req, "locations.moderate"))) {
      return;
    }
    const { data } = await adminClient.from("locations").select("host_id").eq("id", locationId).maybeSingle();
    if (!data || data.host_id === req.user.id) {
      return;
    }
    await writeAuditLog(req.user.id, action, "location", locationId, null, { host_id: data.host_id, ...metadata });
  } catch (error) {
    console.error(`Failed to audit ${action} on location ${locationId}:`, error);
  }
}

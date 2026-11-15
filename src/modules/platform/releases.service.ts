import { ConflictError, NotFoundError, ValidationError } from "../../errors/AppError";
import { ClientPlatform } from "../../lib/clientInfo";
import { adminClient } from "../../lib/supabase";
import { writeAuditLog } from "../admin/audit.service";
import { webPushPublicKey } from "../outreach/channels.service";
import {
  AppConfigQuery,
  CreateFeatureFlagInput,
  CreateIncidentInput,
  CreateReleaseInput,
  UpdateFeatureFlagInput,
  UpdateIncidentInput,
  UpdatePlatformInput,
  UpdateReleaseInput,
} from "./releases.schema";

/**
 * Admin Console 2: platform release control (migration 20261115170000_platform_release_control).
 *
 * The admin side edits; the apps read ONE thing -- GET /v1/app-config -- which folds platform
 * status, update prompts, maintenance mode, feature flags and open public incidents into a single
 * small, cacheable response. The app decides what to show; the backend decides what is true.
 */

const UNIQUE_VIOLATION = "23505";

// ---------------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------------

/** Numeric dotted-version compare: 1.10 > 1.9, 1.2 == 1.2.0. Non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) {
      return d < 0 ? -1 : 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------------

export interface PlatformRow {
  id: string;
  platform: ClientPlatform;
  display_name: string;
  status: string;
  live_version: string | null;
  latest_version: string | null;
  min_supported_version: string | null;
  store_url: string | null;
  update_message: string | null;
  force_update_message: string | null;
  maintenance_mode: boolean;
  maintenance_message: string | null;
  notes: string | null;
  updated_by: string | null;
  updated_at: string;
}

export interface FlagTarget {
  enabled: boolean;
  min_version?: string | null;
}

export interface FeatureFlagRow {
  id: string;
  key: string;
  name: string;
  description: string;
  targets: Partial<Record<ClientPlatform, FlagTarget>>;
  updated_at: string;
}

const PLATFORM_COLUMNS =
  "id, platform, display_name, status, live_version, latest_version, min_supported_version, store_url, update_message, " +
  "force_update_message, maintenance_mode, maintenance_message, notes, updated_by, updated_at";
const FLAG_COLUMNS = "id, key, name, description, targets, updated_at";
const INCIDENT_COLUMNS = "id, title, summary, severity, status, platforms, is_public, started_at, resolved_at, created_by, created_at, updated_at";
const RELEASE_COLUMNS =
  "id, platform, version, title, notes, status, target_date, released_at, feature_keys, created_by, updated_by, created_at, updated_at";

async function rows<T>(table: string, columns: string, order: string, ascending = true): Promise<T[]> {
  const { data, error } = await adminClient.from(table).select(columns).order(order, { ascending });
  if (error) {
    throw error;
  }
  return (data ?? []) as unknown as T[];
}

// ---------------------------------------------------------------------------------------------------
// Admin overview
// ---------------------------------------------------------------------------------------------------

async function pushHealth(): Promise<Record<string, { sent: number; failed: number; invalid_token: number; skipped: number }>> {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const { data, error } = await adminClient
    .from("notification_delivery_attempts")
    .select("provider, status")
    .gte("created_at", since)
    .limit(10_000);
  if (error) {
    throw error;
  }
  const out: Record<string, { sent: number; failed: number; invalid_token: number; skipped: number }> = {};
  for (const row of (data ?? []) as { provider: string; status: "sent" | "failed" | "invalid_token" | "skipped" }[]) {
    const bucket = (out[row.provider] ??= { sent: 0, failed: 0, invalid_token: 0, skipped: 0 });
    bucket[row.status] += 1;
  }
  return out;
}

async function activeDevices(): Promise<Record<ClientPlatform, number>> {
  const result: Record<ClientPlatform, number> = { ios: 0, android: 0, web: 0 };
  await Promise.all(
    (["ios", "android", "web"] as const).map(async (platform) => {
      const { count, error } = await adminClient
        .from("user_devices")
        .select("id", { count: "exact", head: true })
        .eq("platform", platform)
        .eq("is_active", true);
      if (error) {
        throw error;
      }
      result[platform] = count ?? 0;
    })
  );
  return result;
}

export async function getPlatformsOverview() {
  const [platforms, flags, incidents, releases, versionsResult, push, devices] = await Promise.all([
    rows<PlatformRow>("app_platforms", PLATFORM_COLUMNS, "platform"),
    rows<FeatureFlagRow>("feature_flags", FLAG_COLUMNS, "key"),
    adminClient.from("platform_incidents").select(INCIDENT_COLUMNS).order("started_at", { ascending: false }).limit(50),
    adminClient.from("release_plans").select(RELEASE_COLUMNS).order("target_date", { ascending: true, nullsFirst: false }).limit(200),
    adminClient.rpc("admin_client_versions", { _days: 30 }),
    pushHealth(),
    activeDevices(),
  ]);
  for (const result of [incidents, releases, versionsResult]) {
    if (result.error) {
      throw result.error;
    }
  }
  const incidentRows = (incidents.data ?? []) as unknown as { id: string }[];
  const { data: updates, error: updatesError } = await adminClient
    .from("platform_incident_updates")
    .select("id, incident_id, status, message, created_by, created_at")
    .in("incident_id", incidentRows.map((i) => i.id))
    .order("created_at", { ascending: true });
  if (updatesError) {
    throw updatesError;
  }
  const byIncident = new Map<string, unknown[]>();
  for (const update of (updates ?? []) as { incident_id: string }[]) {
    byIncident.set(update.incident_id, [...(byIncident.get(update.incident_id) ?? []), update]);
  }

  return {
    platforms,
    feature_flags: flags,
    incidents: incidentRows.map((i) => ({ ...i, updates: byIncident.get(i.id) ?? [] })),
    releases: releases.data ?? [],
    versions_in_use: ((versionsResult.data ?? []) as Record<string, unknown>[]).map((v) => ({
      ...v,
      users: Number(v.users),
      devices: Number(v.devices),
    })),
    health: {
      push_last_24h: push,
      active_devices: devices,
      backend: {
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
        commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
        region: process.env.VERCEL_REGION ?? null,
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------------------------------

export async function updatePlatform(actorId: string, platform: ClientPlatform, input: UpdatePlatformInput): Promise<PlatformRow> {
  const merged = await adminClient.from("app_platforms").select(PLATFORM_COLUMNS).eq("platform", platform).single();
  if (merged.error) {
    throw merged.error;
  }
  const next = { ...(merged.data as unknown as PlatformRow), ...input };
  if (next.min_supported_version && next.latest_version && compareVersions(next.min_supported_version, next.latest_version) > 0) {
    throw new ValidationError("The minimum supported version cannot be newer than the latest version.");
  }
  const { data, error } = await adminClient
    .from("app_platforms")
    .update({ ...input, updated_by: actorId })
    .eq("platform", platform)
    .select(PLATFORM_COLUMNS)
    .single();
  if (error) {
    throw error;
  }
  const row = data as unknown as PlatformRow;
  appConfigCache.clear();
  await writeAuditLog(actorId, "ADMIN_UPDATED_PLATFORM", "platform", row.id, null, { platform, changes: input });
  return row;
}

// ---------------------------------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------------------------------

export async function createFeatureFlag(actorId: string, input: CreateFeatureFlagInput): Promise<FeatureFlagRow> {
  const { data, error } = await adminClient
    .from("feature_flags")
    .insert({ ...input, updated_by: actorId })
    .select(FLAG_COLUMNS)
    .single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      throw new ConflictError(`A feature flag "${input.key}" already exists.`);
    }
    throw error;
  }
  const row = data as unknown as FeatureFlagRow;
  appConfigCache.clear();
  await writeAuditLog(actorId, "ADMIN_UPDATED_FEATURE_FLAG", "feature_flag", row.id, null, { key: row.key, change: "created", targets: row.targets });
  return row;
}

export async function updateFeatureFlag(actorId: string, id: string, input: UpdateFeatureFlagInput): Promise<FeatureFlagRow> {
  const { data, error } = await adminClient
    .from("feature_flags")
    .update({ ...input, updated_by: actorId })
    .eq("id", id)
    .select(FLAG_COLUMNS)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Feature flag not found.");
  }
  const row = data as unknown as FeatureFlagRow;
  appConfigCache.clear();
  await writeAuditLog(actorId, "ADMIN_UPDATED_FEATURE_FLAG", "feature_flag", id, null, { key: row.key, change: "updated", ...input });
  return row;
}

export async function deleteFeatureFlag(actorId: string, id: string): Promise<void> {
  const { data, error } = await adminClient.from("feature_flags").delete().eq("id", id).select("key").maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Feature flag not found.");
  }
  appConfigCache.clear();
  await writeAuditLog(actorId, "ADMIN_DELETED_FEATURE_FLAG", "feature_flag", id, null, { key: (data as { key: string }).key });
}

// ---------------------------------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------------------------------

export async function createIncident(actorId: string, input: CreateIncidentInput) {
  const { message, ...fields } = input;
  const { data, error } = await adminClient
    .from("platform_incidents")
    .insert({ ...fields, created_by: actorId })
    .select(INCIDENT_COLUMNS)
    .single();
  if (error) {
    throw error;
  }
  const incident = data as unknown as { id: string; status: string };
  await adminClient.from("platform_incident_updates").insert({
    incident_id: incident.id,
    status: incident.status,
    message: message ?? "Incident opened.",
    created_by: actorId,
  });
  appConfigCache.clear();
  await writeAuditLog(actorId, "ADMIN_CREATED_INCIDENT", "incident", incident.id, null, {
    title: input.title,
    severity: input.severity,
    platforms: input.platforms,
  });
  return incident;
}

export async function updateIncident(actorId: string, id: string, input: UpdateIncidentInput) {
  const { message, ...fields } = input;
  const { data: before, error: readError } = await adminClient.from("platform_incidents").select("status").eq("id", id).maybeSingle();
  if (readError) {
    throw readError;
  }
  if (!before) {
    throw new NotFoundError("Incident not found.");
  }
  const resolving = fields.status === "resolved" && before.status !== "resolved";
  const reopening = fields.status !== undefined && fields.status !== "resolved" && before.status === "resolved";
  const patch: Record<string, unknown> = { ...fields };
  if (resolving) {
    patch.resolved_at = new Date().toISOString();
  } else if (reopening) {
    patch.resolved_at = null;
  }
  const { data, error } = await adminClient.from("platform_incidents").update(patch).eq("id", id).select(INCIDENT_COLUMNS).single();
  if (error) {
    throw error;
  }
  const status = (data as { status: string }).status;
  if (message || fields.status !== undefined) {
    await adminClient.from("platform_incident_updates").insert({
      incident_id: id,
      status,
      message: message ?? `Status changed to ${status}.`,
      created_by: actorId,
    });
  }
  appConfigCache.clear();
  await writeAuditLog(actorId, "ADMIN_UPDATED_INCIDENT", "incident", id, null, { fields: Object.keys(input), status });
  return data;
}

// ---------------------------------------------------------------------------------------------------
// Release plans
// ---------------------------------------------------------------------------------------------------

async function promoteToLive(actorId: string, platform: string, version: string): Promise<void> {
  if (!["ios", "android", "web"].includes(platform) || !/^\d+(\.\d+){0,3}$/.test(version)) {
    return;
  }
  const { data, error } = await adminClient
    .from("app_platforms")
    .update({ live_version: version, latest_version: version, updated_by: actorId })
    .eq("platform", platform)
    .select("id")
    .single();
  if (error) {
    throw error;
  }
  appConfigCache.clear();
  await writeAuditLog(actorId, "ADMIN_UPDATED_PLATFORM", "platform", (data as { id: string }).id, null, {
    platform,
    changes: { live_version: version, latest_version: version },
    via: "release",
  });
}

export async function createRelease(actorId: string, input: CreateReleaseInput) {
  const { promote_to_live, ...fields } = input;
  const { data, error } = await adminClient
    .from("release_plans")
    .insert({
      ...fields,
      released_at: fields.status === "released" ? new Date().toISOString() : null,
      created_by: actorId,
      updated_by: actorId,
    })
    .select(RELEASE_COLUMNS)
    .single();
  if (error) {
    throw error;
  }
  const release = data as unknown as { id: string; platform: string; version: string; status: string };
  await writeAuditLog(actorId, "ADMIN_CREATED_RELEASE", "release", release.id, null, {
    platform: release.platform,
    version: release.version,
    status: release.status,
  });
  if (release.status === "released" && promote_to_live) {
    await promoteToLive(actorId, release.platform, release.version);
  }
  return release;
}

export async function updateRelease(actorId: string, id: string, input: UpdateReleaseInput) {
  const { promote_to_live, ...fields } = input;
  const { data: before, error: readError } = await adminClient.from("release_plans").select("status").eq("id", id).maybeSingle();
  if (readError) {
    throw readError;
  }
  if (!before) {
    throw new NotFoundError("Release not found.");
  }
  const patch: Record<string, unknown> = { ...fields, updated_by: actorId };
  if (fields.status === "released" && before.status !== "released") {
    patch.released_at = new Date().toISOString();
  } else if (fields.status !== undefined && fields.status !== "released") {
    patch.released_at = null;
  }
  const { data, error } = await adminClient.from("release_plans").update(patch).eq("id", id).select(RELEASE_COLUMNS).single();
  if (error) {
    throw error;
  }
  const release = data as unknown as { id: string; platform: string; version: string; status: string };
  await writeAuditLog(actorId, "ADMIN_UPDATED_RELEASE", "release", id, null, { fields: Object.keys(fields), status: release.status });
  if (release.status === "released" && promote_to_live) {
    await promoteToLive(actorId, release.platform, release.version);
  }
  return release;
}

export async function deleteRelease(actorId: string, id: string): Promise<void> {
  const { data, error } = await adminClient.from("release_plans").delete().eq("id", id).select("platform, version").maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Release not found.");
  }
  await writeAuditLog(actorId, "ADMIN_DELETED_RELEASE", "release", id, null, data as Record<string, unknown>);
}

// ---------------------------------------------------------------------------------------------------
// Public: GET /v1/app-config
// ---------------------------------------------------------------------------------------------------

const APP_CONFIG_TTL_MS = 30_000;
const appConfigCache = new Map<string, { at: number; value: { platform: PlatformRow; flags: FeatureFlagRow[]; incidents: unknown[] } }>();

async function configInputs(platform: ClientPlatform) {
  const hit = appConfigCache.get(platform);
  if (hit && Date.now() - hit.at < APP_CONFIG_TTL_MS) {
    return hit.value;
  }
  const [platformResult, flags, incidents] = await Promise.all([
    adminClient.from("app_platforms").select(PLATFORM_COLUMNS).eq("platform", platform).single(),
    rows<FeatureFlagRow>("feature_flags", FLAG_COLUMNS, "key"),
    adminClient
      .from("platform_incidents")
      .select("id, title, summary, severity, status, started_at")
      .eq("is_public", true)
      .neq("status", "resolved")
      .contains("platforms", [platform])
      .order("started_at", { ascending: false }),
  ]);
  if (platformResult.error) {
    throw platformResult.error;
  }
  if (incidents.error) {
    throw incidents.error;
  }
  const value = { platform: platformResult.data as unknown as PlatformRow, flags, incidents: incidents.data ?? [] };
  appConfigCache.set(platform, { at: Date.now(), value });
  return value;
}

export async function getAppConfig(query: AppConfigQuery) {
  const { platform: row, flags, incidents } = await configInputs(query.platform);
  const version = query.version ?? null;

  const required = Boolean(version && row.min_supported_version && compareVersions(version, row.min_supported_version) < 0);
  const available = Boolean(version && row.latest_version && compareVersions(version, row.latest_version) < 0);

  const features: Record<string, boolean> = {};
  for (const flag of flags) {
    const target = flag.targets?.[query.platform];
    features[flag.key] = Boolean(
      target?.enabled && (!target.min_version || (version !== null && compareVersions(version, target.min_version) >= 0))
    );
  }

  return {
    platform: query.platform,
    status: row.status,
    maintenance: { active: row.maintenance_mode, message: row.maintenance_mode ? row.maintenance_message : null },
    update: {
      required,
      available: available || required,
      latest_version: row.latest_version,
      min_supported_version: row.min_supported_version,
      store_url: row.store_url,
      message: required ? (row.force_update_message ?? row.update_message) : available ? row.update_message : null,
    },
    features,
    incidents,
    ...(query.platform === "web" ? { web_push_public_key: await webPushPublicKey() } : {}),
  };
}

/** Tests only. */
export function resetReleaseCachesForTesting(): void {
  appConfigCache.clear();
}

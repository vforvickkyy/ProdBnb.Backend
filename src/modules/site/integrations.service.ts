import { env } from "../../config/env";
import { ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { writeAuditLog } from "../admin/audit.service";
import { getPlatformSettings } from "../platform/settings.service";
import { SaveGoogleMapsInput, SaveVercelInput, SiteProvider } from "./site.schema";
import { getProject, VercelTarget } from "./vercel";

/**
 * Website integrations (Console 3): Google Maps for the public site's maps and place search, and
 * Vercel for managing the site's domains from the admin console.
 *
 * Same rules as the messaging channels: secrets (the Maps server key, the Vercel token) are written
 * to Supabase Vault through `site_integration_save` and read back only by this backend through
 * `site_integration_secret`; nothing here ever returns a secret to an API caller. The Maps
 * *browser* key is different by nature -- every visitor's browser receives it -- so it is plain
 * configuration, protected by the HTTP-referrer restriction set on it in Google Cloud.
 */

const PROVIDERS: readonly SiteProvider[] = ["google_maps", "vercel"];

interface IntegrationRow {
  id: string;
  provider: SiteProvider;
  config: Record<string, unknown>;
  secret_id: string | null;
  enabled: boolean;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  updated_at: string;
}

export interface SiteIntegrationStatus {
  provider: SiteProvider;
  connected: boolean;
  /** Safe-to-show configuration only: masked keys, ids, names. */
  config: Record<string, unknown>;
  has_secret: boolean;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  updated_at: string | null;
}

const COLUMNS = "id, provider, config, secret_id, enabled, last_tested_at, last_test_ok, last_test_error, updated_at";

async function loadRow(provider: SiteProvider): Promise<IntegrationRow | null> {
  const { data, error } = await adminClient.from("site_integrations").select(COLUMNS).eq("provider", provider).maybeSingle();
  if (error) throw error;
  return (data as IntegrationRow | null) ?? null;
}

async function loadSecret(provider: SiteProvider): Promise<string | null> {
  const { data, error } = await adminClient.rpc("site_integration_secret", { _provider: provider });
  if (error) throw error;
  return (data as string | null) ?? null;
}

/** "AIzaSy…x9Qk" -- enough to recognise a key without printing it. */
export function maskKey(key: unknown): string | null {
  if (typeof key !== "string" || key.length < 12) return null;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function publicConfig(row: IntegrationRow): Record<string, unknown> {
  if (row.provider === "google_maps") {
    return { browser_key_preview: maskKey(row.config.browser_key), map_id: row.config.map_id ?? null };
  }
  return { project_id: row.config.project_id ?? null, project_name: row.config.project_name ?? null, team_id: row.config.team_id ?? null };
}

function toStatus(provider: SiteProvider, row: IntegrationRow | null): SiteIntegrationStatus {
  return {
    provider,
    connected: Boolean(row?.enabled),
    config: row ? publicConfig(row) : {},
    has_secret: Boolean(row?.secret_id),
    last_tested_at: row?.last_tested_at ?? null,
    last_test_ok: row?.last_test_ok ?? null,
    last_test_error: row?.last_test_error ?? null,
    updated_at: row?.updated_at ?? null,
  };
}

export async function listSiteIntegrations(): Promise<SiteIntegrationStatus[]> {
  const { data, error } = await adminClient.from("site_integrations").select(COLUMNS);
  if (error) throw error;
  const rows = (data ?? []) as IntegrationRow[];
  return PROVIDERS.map((provider) => toStatus(provider, rows.find((r) => r.provider === provider) ?? null));
}

async function save(provider: SiteProvider, actorId: string, config: Record<string, unknown>, secret: string | null, metadata: Record<string, unknown>) {
  const { data, error } = await adminClient.rpc("site_integration_save", {
    _provider: provider,
    _config: config,
    _secret: secret,
    _actor_id: actorId,
  });
  if (error) throw error;
  await writeAuditLog(actorId, "ADMIN_CONNECTED_SITE_INTEGRATION", "site_integration", data as string, null, { provider, ...metadata });
  clearSiteConfigCache();
  return toStatus(provider, await loadRow(provider));
}

export async function saveGoogleMaps(actorId: string, input: SaveGoogleMapsInput): Promise<SiteIntegrationStatus> {
  const existing = await loadRow("google_maps");
  const mapId = input.map_id === undefined ? ((existing?.config.map_id as string | null | undefined) ?? null) : input.map_id;
  return save(
    "google_maps",
    actorId,
    { browser_key: input.browser_key, map_id: mapId },
    input.server_key ?? null,
    { map_id_set: Boolean(mapId), server_key_replaced: Boolean(input.server_key) }
  );
}

export async function saveVercel(actorId: string, input: SaveVercelInput): Promise<SiteIntegrationStatus> {
  const existing = await loadRow("vercel");
  const token = input.token ?? (existing?.secret_id ? await loadSecret("vercel") : null);
  if (!token) {
    throw new ValidationError("Paste a Vercel access token to connect.");
  }
  // Prove the token can see this project before anything is stored.
  const project = await getProject({ token, projectId: input.project_id, teamId: input.team_id ?? null });
  return save(
    "vercel",
    actorId,
    { project_id: project.id, project_name: project.name, team_id: input.team_id ?? null },
    input.token ?? null,
    { project_id: project.id, token_replaced: Boolean(input.token) }
  );
}

export async function removeSiteIntegration(actorId: string, provider: SiteProvider): Promise<boolean> {
  const row = await loadRow(provider);
  const { data, error } = await adminClient.rpc("site_integration_remove", { _provider: provider });
  if (error) throw error;
  if (row) {
    await writeAuditLog(actorId, "ADMIN_DISCONNECTED_SITE_INTEGRATION", "site_integration", row.id, null, { provider });
  }
  clearSiteConfigCache();
  return Boolean(data);
}

async function recordTest(provider: SiteProvider, ok: boolean, detail: string): Promise<void> {
  await adminClient
    .from("site_integrations")
    .update({ last_tested_at: new Date().toISOString(), last_test_ok: ok, last_test_error: ok ? null : detail.slice(0, 500) })
    .eq("provider", provider);
}

export async function testSiteIntegration(provider: SiteProvider): Promise<{ ok: boolean; detail: string }> {
  const row = await loadRow(provider);
  if (!row) throw new ValidationError("Connect it first.");
  let result: { ok: boolean; detail: string };

  if (provider === "vercel") {
    try {
      const target = await vercelTarget();
      const project = await getProject(target);
      result = { ok: true, detail: `Connected to the Vercel project “${project.name}”.` };
    } catch (e) {
      result = { ok: false, detail: e instanceof Error ? e.message : "Vercel did not answer." };
    }
  } else {
    const serverKey = row.secret_id ? await loadSecret("google_maps") : null;
    if (!serverKey) {
      // A browser key restricted to the site's domains (as it should be) is refused by Google when
      // called from a server, so it can only be proven in a browser -- the admin page does that.
      result = { ok: true, detail: "Browser key saved. The map preview on this page confirms it works for your domains." };
    } else {
      result = await testGeocoding(serverKey);
    }
  }
  await recordTest(provider, result.ok, result.detail);
  return result;
}

async function testGeocoding(key: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", "Gateway of India, Mumbai");
    url.searchParams.set("key", key);
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as { status?: string; error_message?: string };
    if (body.status === "OK") return { ok: true, detail: "Server key works: Google geocoded a test address." };
    return { ok: false, detail: `Google answered ${body.status ?? res.status}${body.error_message ? `: ${body.error_message}` : ""}` };
  } catch {
    return { ok: false, detail: "Could not reach Google Maps from the backend." };
  }
}

/** The Vercel project the website deploys to, with its token -- for domain management only. */
export async function vercelTarget(): Promise<VercelTarget> {
  const row = await loadRow("vercel");
  const token = row?.secret_id ? await loadSecret("vercel") : null;
  if (!row || !token || typeof row.config.project_id !== "string") {
    throw new ValidationError("Connect the website's Vercel project first (Website → Domains → Connect Vercel).");
  }
  return { token, projectId: row.config.project_id, teamId: typeof row.config.team_id === "string" ? row.config.team_id : null };
}

export async function isVercelConnected(): Promise<boolean> {
  const row = await loadRow("vercel");
  return Boolean(row?.secret_id && row.config.project_id);
}

// -- Site settings + the public config the website reads --------------------------------------------

export interface SiteSettings {
  id: string;
  primary_domain: string | null;
  /** Contact address shown on the website (footer, pages). */
  support_email: string | null;
  updated_at: string;
}

const SITE_SETTINGS_COLUMNS = "id, primary_domain, support_email, updated_at";

export async function getSiteSettings(): Promise<SiteSettings> {
  const { data, error } = await adminClient.from("site_settings").select(SITE_SETTINGS_COLUMNS).eq("singleton", true).single();
  if (error) throw error;
  return data as SiteSettings;
}

export async function setPrimaryDomainRow(actorId: string, domain: string | null): Promise<SiteSettings> {
  const { data, error } = await adminClient
    .from("site_settings")
    .update({ primary_domain: domain, updated_by: actorId })
    .eq("singleton", true)
    .select(SITE_SETTINGS_COLUMNS)
    .single();
  if (error) throw error;
  clearSiteConfigCache();
  return data as SiteSettings;
}

/** The website's contact email. Audited as a settings change on the site. */
export async function setSupportEmail(actorId: string, email: string | null, reason?: string | null): Promise<SiteSettings> {
  const before = await getSiteSettings();
  const { data, error } = await adminClient
    .from("site_settings")
    .update({ support_email: email, updated_by: actorId })
    .eq("singleton", true)
    .select(SITE_SETTINGS_COLUMNS)
    .single();
  if (error) throw error;
  clearSiteConfigCache();
  const after = data as SiteSettings;
  if (before.support_email !== after.support_email) {
    await writeAuditLog(actorId, "ADMIN_UPDATED_SETTINGS", "site", after.id, reason ?? null, {
      changes: { support_email: { from: before.support_email, to: after.support_email } },
    });
  }
  return after;
}

export interface PublicSiteConfig {
  site: { primary_domain: string | null; url: string | null; support_email: string | null };
  maps: { provider: "google"; browser_key: string; map_id: string | null } | null;
  features: { availability_requires_login: boolean };
  /** Which checkout the website loads. No keys: the order's session id is all a browser needs. */
  payments: { provider: "cashfree"; mode: "sandbox" | "production" };
}

const PUBLIC_TTL_MS = 60_000;
let publicCache: { value: PublicSiteConfig; at: number } | null = null;

export function clearSiteConfigCache(): void {
  publicCache = null;
}

/**
 * What the public website needs to know at runtime -- served by GET /v1/site-config. Contains no
 * secret: the Maps browser key is public by design (see the top of this file).
 */
export async function getPublicSiteConfig(): Promise<PublicSiteConfig> {
  if (publicCache && Date.now() - publicCache.at < PUBLIC_TTL_MS) return publicCache.value;
  const [settings, maps, platform] = await Promise.all([getSiteSettings(), loadRow("google_maps"), getPlatformSettings()]);
  const browserKey = maps?.enabled && typeof maps.config.browser_key === "string" ? maps.config.browser_key : null;
  const value: PublicSiteConfig = {
    site: {
      primary_domain: settings.primary_domain,
      url: settings.primary_domain ? `https://${settings.primary_domain}` : null,
      support_email: settings.support_email,
    },
    maps: browserKey ? { provider: "google", browser_key: browserKey, map_id: (maps!.config.map_id as string | null) ?? null } : null,
    features: { availability_requires_login: platform.availability_requires_login },
    payments: { provider: "cashfree", mode: env.CASHFREE_ENV === "test" ? "sandbox" : "production" },
  };
  publicCache = { value, at: Date.now() };
  return value;
}

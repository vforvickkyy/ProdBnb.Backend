import { env } from "../../config/env";
import { ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { writeAuditLog } from "../admin/audit.service";
import { isProviderId, PROVIDERS, SmsProviderId } from "./providers";
import { normalizePhone } from "./text";

/**
 * SMS settings (Messaging -> SMS in the admin): mode, active provider, DLT sender details, and the
 * connected providers' keys (in Vault, never returned). Cached for a short while so a burst of
 * texts doesn't decrypt the key for each one; saving clears this instance's cache.
 */

export type SmsMode = "off" | "test" | "live";

export interface SmsSettingsRow {
  mode: SmsMode;
  active_provider: SmsProviderId | null;
  sender_id: string | null;
  dlt_entity_id: string | null;
  test_numbers: string[];
  otp_per_hour: number;
  webhook_token: string;
  updated_at: string;
}

interface ProviderRow {
  provider: SmsProviderId;
  config: Record<string, string>;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  updated_at: string;
}

/** The admin's view of one SMS provider. Never includes a key. */
export interface ProviderStatus {
  id: SmsProviderId;
  name: string;
  website: string;
  connected: boolean;
  active: boolean;
  config: Record<string, string>;
  fields: { key: string; label: string; secret: boolean; required: boolean; placeholder?: string; help?: string; saved: boolean }[];
  report_setup: string;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
}

/** Fixed id for SMS rows in the audit log (its target_id is a uuid). */
const SMS_AUDIT_TARGET = "00000000-0000-4000-8000-00000000a5a5";
const CACHE_TTL_MS = 30_000;

let cached: { settings: SmsSettingsRow; at: number } | null = null;
const secretCache = new Map<SmsProviderId, { config: Record<string, string>; secret: Record<string, string>; at: number }>();

export function clearSmsCache(): void {
  cached = null;
  secretCache.clear();
}

const SETTINGS_COLUMNS = "mode, active_provider, sender_id, dlt_entity_id, test_numbers, otp_per_hour, webhook_token, updated_at";

export async function smsSettings(): Promise<SmsSettingsRow> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.settings;
  const { data, error } = await adminClient.from("sms_settings").select(SETTINGS_COLUMNS).eq("singleton", true).maybeSingle();
  if (error) throw error;
  const settings = (data as SmsSettingsRow | null) ?? {
    mode: "test",
    active_provider: null,
    sender_id: null,
    dlt_entity_id: null,
    test_numbers: [],
    otp_per_hour: 5,
    webhook_token: "",
    updated_at: new Date().toISOString(),
  };
  cached = { settings, at: Date.now() };
  return settings;
}

/** The connected provider's settings and key, or null. */
export async function providerCredentials(provider: SmsProviderId): Promise<{ config: Record<string, string>; secret: Record<string, string> } | null> {
  const hit = secretCache.get(provider);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
  const { data: row, error } = await adminClient.from("sms_providers").select("config").eq("provider", provider).maybeSingle();
  if (error) throw error;
  if (!row) return null;
  const { data: raw, error: secretError } = await adminClient.rpc("sms_provider_secret", { _provider: provider });
  if (secretError) throw secretError;
  let secret: Record<string, string> = {};
  try {
    secret = typeof raw === "string" ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    secret = {};
  }
  const entry = { config: (row.config as Record<string, string>) ?? {}, secret, at: Date.now() };
  secretCache.set(provider, entry);
  return entry;
}

/** The address a provider posts delivery reports to. */
export function reportUrl(provider: SmsProviderId, token: string): string {
  return `${env.API_BASE_URL.replace(/\/$/, "")}/v1/webhooks/sms/${provider}?token=${token}`;
}

export async function smsOverview(): Promise<{ settings: Omit<SmsSettingsRow, "webhook_token">; providers: ProviderStatus[]; report_urls: Record<string, string>; sign_in_hook_ready: boolean }> {
  const settings = await smsSettings();
  const { data, error } = await adminClient.from("sms_providers").select("provider, config, last_tested_at, last_test_ok, last_test_error, updated_at");
  if (error) throw error;
  const rows = new Map(((data ?? []) as ProviderRow[]).map((r) => [r.provider, r]));
  const providers = Object.values(PROVIDERS).map((def): ProviderStatus => {
    const row = rows.get(def.id);
    return {
      id: def.id,
      name: def.name,
      website: def.website,
      connected: Boolean(row),
      active: settings.active_provider === def.id,
      config: row?.config ?? {},
      fields: def.fields.map((f) => ({ ...f, saved: Boolean(row) && (f.secret || Boolean(row?.config?.[f.key])) })),
      report_setup: def.reportSetup,
      last_tested_at: row?.last_tested_at ?? null,
      last_test_ok: row?.last_test_ok ?? null,
      last_test_error: row?.last_test_error ?? null,
    };
  });
  const { webhook_token: token, ...rest } = settings;
  return {
    settings: rest,
    providers,
    report_urls: Object.fromEntries(providers.map((p) => [p.id, reportUrl(p.id, token)])),
    sign_in_hook_ready: Boolean(env.AUTH_SMS_HOOK_SECRET),
  };
}

export interface UpdateSmsSettingsInput {
  mode?: SmsMode;
  active_provider?: SmsProviderId | null;
  sender_id?: string | null;
  dlt_entity_id?: string | null;
  test_numbers?: string[];
  otp_per_hour?: number;
}

export async function updateSmsSettings(actorId: string, input: UpdateSmsSettingsInput): Promise<void> {
  const patch: Record<string, unknown> = { updated_by: actorId };
  if (input.mode !== undefined) patch.mode = input.mode;
  if (input.sender_id !== undefined) patch.sender_id = input.sender_id ? input.sender_id.toUpperCase() : null;
  if (input.dlt_entity_id !== undefined) patch.dlt_entity_id = input.dlt_entity_id || null;
  if (input.otp_per_hour !== undefined) patch.otp_per_hour = input.otp_per_hour;
  if (input.test_numbers !== undefined) {
    const numbers: string[] = [];
    for (const raw of input.test_numbers) {
      const n = normalizePhone(raw);
      if (!n) throw new ValidationError(`"${raw}" isn't a mobile number.`);
      if (!numbers.includes(n)) numbers.push(n);
    }
    patch.test_numbers = numbers;
  }
  if (input.active_provider !== undefined) {
    if (input.active_provider) {
      const { data } = await adminClient.from("sms_providers").select("provider").eq("provider", input.active_provider).maybeSingle();
      if (!data) throw new ValidationError(`Connect ${PROVIDERS[input.active_provider].name} first (paste its key), then choose it.`);
    }
    patch.active_provider = input.active_provider;
  }
  const next = { ...(await smsSettings()), ...patch } as SmsSettingsRow;
  if (next.mode === "live" && !next.active_provider) {
    throw new ValidationError("Choose a connected provider before switching to Live.");
  }
  const { error } = await adminClient.from("sms_settings").update(patch).eq("singleton", true);
  if (error) throw error;
  clearSmsCache();
  await writeAuditLog(actorId, "ADMIN_UPDATED_SETTINGS", "channel", SMS_AUDIT_TARGET, null, { area: "sms", ...patch, updated_by: undefined });
}

/** Saves a provider's settings and key. Secret fields left empty keep the stored key. */
export async function saveProvider(actorId: string, provider: string, values: Record<string, string | undefined>): Promise<void> {
  if (!isProviderId(provider)) throw new ValidationError("Unknown SMS provider.");
  const def = PROVIDERS[provider];
  const { data: existing } = await adminClient.from("sms_providers").select("config").eq("provider", provider).maybeSingle();
  const config: Record<string, string> = {};
  const secret: Record<string, string> = {};
  let secretGiven = false;
  for (const field of def.fields) {
    const value = values[field.key]?.trim();
    if (field.secret) {
      if (value) {
        secret[field.key] = value;
        secretGiven = true;
      } else if (!existing && field.required) {
        throw new ValidationError(`${field.label} is needed to connect ${def.name}.`);
      }
    } else if (value) {
      config[field.key] = value;
    } else if (field.required) {
      throw new ValidationError(`${field.label} is needed.`);
    }
  }
  let secretJson: string | null = null;
  if (secretGiven) {
    // Keep any other stored secret fields the form left empty.
    const previous = existing ? (await providerCredentials(provider))?.secret ?? {} : {};
    secretJson = JSON.stringify({ ...previous, ...secret });
  }
  const { error } = await adminClient.rpc("sms_provider_save", { _provider: provider, _config: config, _secret: secretJson, _actor_id: actorId });
  if (error) {
    if (/secret_required/.test(error.message)) throw new ValidationError(`Paste the ${def.name} key to connect it.`);
    throw error;
  }
  clearSmsCache();
  await writeAuditLog(actorId, "ADMIN_CONNECTED_CHANNEL", "channel", SMS_AUDIT_TARGET, null, { channel: `sms:${provider}`, replaced_secret: secretGiven, config });
}

export async function removeProvider(actorId: string, provider: string): Promise<void> {
  if (!isProviderId(provider)) throw new ValidationError("Unknown SMS provider.");
  const { data, error } = await adminClient.rpc("sms_provider_remove", { _provider: provider });
  if (error) throw error;
  if (!data) throw new ValidationError("That provider isn't connected.");
  clearSmsCache();
  await writeAuditLog(actorId, "ADMIN_DISCONNECTED_CHANNEL", "channel", SMS_AUDIT_TARGET, null, { channel: `sms:${provider}`, change: "removed" });
}

export async function recordProviderTest(provider: SmsProviderId, ok: boolean, detail: string | null): Promise<void> {
  await adminClient
    .from("sms_providers")
    .update({ last_tested_at: new Date().toISOString(), last_test_ok: ok, last_test_error: ok ? null : (detail ?? "").slice(0, 1000) })
    .eq("provider", provider);
}

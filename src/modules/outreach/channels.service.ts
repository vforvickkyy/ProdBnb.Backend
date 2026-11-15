import webpush from "web-push";
import { apnsPrivateKeyProblem, env, normalizeApnsPrivateKey } from "../../config/env";
import { ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { writeAuditLog } from "../admin/audit.service";
import { ApnsCredentials, APNsProvider, checkApnsSigning } from "../notifications/providers/APNsProvider";
import { FcmCredentials, FCMProvider, parseServiceAccount } from "../notifications/providers/FCMProvider";
import { generateVapidKeys, WebPushCredentials } from "../notifications/providers/WebPushProvider";
import { ChannelName, SaveChannelInput } from "./outreach.schema";

/**
 * Admin Console 2: sending channels -- SMTP email, APNs (iOS), FCM (Android), Web Push.
 *
 * Secrets go into Supabase Vault through `messaging_channel_save` and come back out only through
 * `messaging_channel_secret`, both service-role-only SQL functions. Nothing in this file ever
 * returns a secret to an API caller: `listChannels()` reports configuration and status only.
 *
 * Credentials are cached in memory for CACHE_TTL_MS so a 10,000-recipient campaign does not
 * decrypt the same secret 10,000 times. Saving/removing a channel clears this instance's cache;
 * other warm instances pick the change up within the TTL.
 */

export const CHANNELS: readonly ChannelName[] = ["smtp", "apns", "fcm", "webpush"];
const CACHE_TTL_MS = 60_000;

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  from_email: string;
  from_name: string;
  reply_to: string | null;
  max_per_minute: number;
}

export interface ChannelRow {
  id: string;
  channel: ChannelName;
  config: Record<string, unknown>;
  enabled: boolean;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  connected_by: string | null;
  updated_at: string;
}

export interface ChannelStatus {
  channel: ChannelName;
  connected: boolean;
  /** `dashboard` = saved here (Vault); `environment` = APNS_* env vars on the backend. */
  source: "dashboard" | "environment" | null;
  enabled: boolean;
  config: Record<string, unknown>;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  updated_at: string | null;
}

interface CachedChannel {
  row: ChannelRow | null;
  secret: Record<string, string> | null;
  at: number;
}

const cache = new Map<ChannelName, CachedChannel>();

export function clearChannelCache(): void {
  cache.clear();
}

async function loadChannel(channel: ChannelName): Promise<CachedChannel> {
  const hit = cache.get(channel);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit;
  }
  const { data, error } = await adminClient
    .from("messaging_channels")
    .select("id, channel, config, enabled, last_tested_at, last_test_ok, last_test_error, connected_by, updated_at")
    .eq("channel", channel)
    .maybeSingle();
  if (error) {
    throw error;
  }
  let secret: Record<string, string> | null = null;
  if (data) {
    const { data: raw, error: secretError } = await adminClient.rpc("messaging_channel_secret", { _channel: channel });
    if (secretError) {
      throw secretError;
    }
    try {
      secret = typeof raw === "string" ? (JSON.parse(raw) as Record<string, string>) : null;
    } catch {
      secret = null;
    }
  }
  const entry = { row: (data as ChannelRow | null) ?? null, secret, at: Date.now() };
  cache.set(channel, entry);
  return entry;
}

function apnsFromEnvAvailable(): boolean {
  return Boolean(
    env.NOTIFICATION_PROVIDER === "apns" && env.APNS_TEAM_ID && env.APNS_KEY_ID && env.APNS_BUNDLE_ID && env.APNS_PRIVATE_KEY
  );
}

// ---------------------------------------------------------------------------------------------------
// Credential accessors used by the providers and the mailer
// ---------------------------------------------------------------------------------------------------

export async function smtpCredentials(): Promise<{ config: SmtpConfig; password: string | null; version: string } | null> {
  const { row, secret } = await loadChannel("smtp");
  if (!row || !row.enabled || !secret) {
    return null;
  }
  return { config: row.config as unknown as SmtpConfig, password: secret.password ?? null, version: row.updated_at };
}

export async function apnsCredentials(): Promise<{ credentials: ApnsCredentials; version: string } | null> {
  const { row, secret } = await loadChannel("apns");
  if (!row || !row.enabled || !secret?.private_key) {
    return null;
  }
  const c = row.config as { team_id: string; key_id: string; bundle_id: string; environment: "sandbox" | "production" };
  return {
    credentials: {
      teamId: c.team_id,
      keyId: c.key_id,
      bundleId: c.bundle_id,
      privateKey: secret.private_key,
      defaultEnvironment: c.environment,
    },
    version: row.updated_at,
  };
}

export async function fcmCredentials(): Promise<{ credentials: FcmCredentials; version: string } | null> {
  const { row, secret } = await loadChannel("fcm");
  if (!row || !row.enabled || !secret?.private_key) {
    return null;
  }
  const c = row.config as { project_id: string; client_email: string };
  return {
    credentials: { projectId: c.project_id, clientEmail: c.client_email, privateKey: secret.private_key },
    version: row.updated_at,
  };
}

export async function webPushCredentials(): Promise<{ credentials: WebPushCredentials; version: string } | null> {
  const { row, secret } = await loadChannel("webpush");
  if (!row || !row.enabled || !secret?.private_key) {
    return null;
  }
  const c = row.config as { public_key: string; subject: string };
  return {
    credentials: { publicKey: c.public_key, privateKey: secret.private_key, subject: c.subject },
    version: row.updated_at,
  };
}

/** The VAPID public key a web client subscribes with -- public by design. */
export async function webPushPublicKey(): Promise<string | null> {
  const { row } = await loadChannel("webpush");
  return row?.enabled ? ((row.config as { public_key?: string }).public_key ?? null) : null;
}

// ---------------------------------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------------------------------

export async function listChannels(): Promise<ChannelStatus[]> {
  const { data, error } = await adminClient
    .from("messaging_channels")
    .select("id, channel, config, enabled, last_tested_at, last_test_ok, last_test_error, connected_by, updated_at");
  if (error) {
    throw error;
  }
  const rows = new Map(((data ?? []) as ChannelRow[]).map((r) => [r.channel, r]));
  return CHANNELS.map((channel) => {
    const row = rows.get(channel);
    if (row) {
      return {
        channel,
        connected: true,
        source: "dashboard",
        enabled: row.enabled,
        config: row.config,
        last_tested_at: row.last_tested_at,
        last_test_ok: row.last_test_ok,
        last_test_error: row.last_test_error,
        updated_at: row.updated_at,
      };
    }
    if (channel === "apns" && apnsFromEnvAvailable()) {
      return {
        channel,
        connected: true,
        source: "environment",
        enabled: true,
        config: { team_id: env.APNS_TEAM_ID, key_id: env.APNS_KEY_ID, bundle_id: env.APNS_BUNDLE_ID, environment: env.APNS_ENVIRONMENT },
        last_tested_at: null,
        last_test_ok: null,
        last_test_error: null,
        updated_at: null,
      };
    }
    return {
      channel,
      connected: false,
      source: null,
      enabled: false,
      config: {},
      last_tested_at: null,
      last_test_ok: null,
      last_test_error: null,
      updated_at: null,
    };
  });
}

async function existingRow(channel: ChannelName): Promise<ChannelRow | null> {
  const { data, error } = await adminClient
    .from("messaging_channels")
    .select("id, channel, config, enabled, last_tested_at, last_test_ok, last_test_error, connected_by, updated_at")
    .eq("channel", channel)
    .maybeSingle();
  if (error) {
    throw error;
  }
  return (data as ChannelRow | null) ?? null;
}

/**
 * Split a channel form into (non-secret config, secret JSON). A secret field left blank on an
 * existing channel keeps the stored secret -- the form never has it to send back.
 */
function prepare(input: SaveChannelInput, existing: ChannelRow | null): { config: Record<string, unknown>; secret: string | null; generated?: { public_key: string } } {
  switch (input.channel) {
    case "smtp": {
      const config: SmtpConfig = {
        host: input.host,
        port: input.port,
        secure: input.secure,
        username: input.username ?? null,
        from_email: input.from_email,
        from_name: input.from_name,
        reply_to: input.reply_to ?? null,
        max_per_minute: input.max_per_minute,
      };
      return { config: { ...config }, secret: input.password !== undefined ? JSON.stringify({ password: input.password }) : null };
    }
    case "apns": {
      let secret: string | null = null;
      if (input.private_key !== undefined) {
        const pem = normalizeApnsPrivateKey(input.private_key);
        const problem = apnsPrivateKeyProblem(pem);
        if (problem) {
          throw new ValidationError(problem);
        }
        secret = JSON.stringify({ private_key: pem });
      }
      return {
        config: { team_id: input.team_id, key_id: input.key_id, bundle_id: input.bundle_id, environment: input.environment },
        secret,
      };
    }
    case "fcm": {
      if (input.service_account_json === undefined) {
        if (!existing) {
          throw new ValidationError("Paste the Firebase service-account JSON to connect FCM.");
        }
        return { config: existing.config, secret: null };
      }
      let parsed: FcmCredentials;
      try {
        parsed = parseServiceAccount(input.service_account_json);
      } catch (error) {
        throw new ValidationError(error instanceof Error ? error.message : "Invalid service account.");
      }
      return {
        config: { project_id: parsed.projectId, client_email: parsed.clientEmail },
        secret: JSON.stringify({ private_key: parsed.privateKey }),
      };
    }
    case "webpush": {
      if (input.generate_keys) {
        const keys = generateVapidKeys();
        return {
          config: { public_key: keys.publicKey, subject: input.subject },
          secret: JSON.stringify({ private_key: keys.privateKey }),
          generated: { public_key: keys.publicKey },
        };
      }
      if (input.public_key && input.private_key) {
        try {
          webpush.setVapidDetails(input.subject, input.public_key, input.private_key);
        } catch (error) {
          throw new ValidationError(error instanceof Error ? error.message : "Invalid VAPID keys.");
        }
        return { config: { public_key: input.public_key, subject: input.subject }, secret: JSON.stringify({ private_key: input.private_key }) };
      }
      if (!existing) {
        throw new ValidationError("Generate a new key pair, or paste both VAPID keys.");
      }
      return { config: { ...existing.config, subject: input.subject }, secret: null };
    }
  }
}

export async function saveChannel(actorId: string, input: SaveChannelInput): Promise<ChannelStatus> {
  const existing = await existingRow(input.channel);
  const { config, secret } = prepare(input, existing);
  const { data: id, error } = await adminClient.rpc("messaging_channel_save", {
    _channel: input.channel,
    _config: config,
    _secret: secret,
    _actor_id: actorId,
  });
  if (error) {
    if (/secret_required/.test(error.message)) {
      throw new ValidationError("This channel is not connected yet -- its secret (password / key) is required.");
    }
    throw error;
  }
  clearChannelCache();
  await writeAuditLog(actorId, "ADMIN_CONNECTED_CHANNEL", "channel", id as string, null, {
    channel: input.channel,
    replaced_secret: secret !== null,
    // Non-secret only: e.g. the SMTP host or APNs key id -- never a password or key.
    config,
  });
  return (await listChannels()).find((c) => c.channel === input.channel)!;
}

export async function setChannelEnabled(actorId: string, channel: ChannelName, enabled: boolean): Promise<ChannelStatus> {
  const existing = await existingRow(channel);
  if (!existing) {
    throw new ValidationError("This channel is not connected.");
  }
  const { error } = await adminClient.from("messaging_channels").update({ enabled }).eq("id", existing.id);
  if (error) {
    throw error;
  }
  clearChannelCache();
  await writeAuditLog(actorId, enabled ? "ADMIN_CONNECTED_CHANNEL" : "ADMIN_DISCONNECTED_CHANNEL", "channel", existing.id, null, {
    channel,
    change: enabled ? "enabled" : "paused",
  });
  return (await listChannels()).find((c) => c.channel === channel)!;
}

export async function removeChannel(actorId: string, channel: ChannelName): Promise<void> {
  const existing = await existingRow(channel);
  if (!existing) {
    throw new ValidationError("This channel is not connected.");
  }
  const { error } = await adminClient.rpc("messaging_channel_remove", { _channel: channel });
  if (error) {
    throw error;
  }
  clearChannelCache();
  await writeAuditLog(actorId, "ADMIN_DISCONNECTED_CHANNEL", "channel", existing.id, null, { channel, change: "removed" });
}

export async function recordTestResult(channel: ChannelName, ok: boolean, detail: string | null): Promise<void> {
  const { error } = await adminClient
    .from("messaging_channels")
    .update({ last_tested_at: new Date().toISOString(), last_test_ok: ok, last_test_error: ok ? null : (detail ?? "").slice(0, 1000) })
    .eq("channel", channel);
  if (error) {
    console.error(`Failed to record ${channel} test result:`, error);
  }
  clearChannelCache();
}

/**
 * Credential check without a device: can we sign/authorize with what is stored? (A real delivery
 * test needs a device token -- see outreach.service testChannel.)
 */
export async function verifyPushCredentials(channel: "apns" | "fcm" | "webpush"): Promise<{ ok: boolean; detail: string }> {
  if (channel === "apns") {
    const stored = await apnsCredentials();
    if (!stored) {
      return apnsFromEnvAvailable() ? checkApnsSigning() : { ok: false, detail: "APNs is not connected." };
    }
    return checkApnsSigning(stored.credentials);
  }
  if (channel === "fcm") {
    const stored = await fcmCredentials();
    if (!stored) {
      return { ok: false, detail: "FCM is not connected." };
    }
    try {
      await new FCMProvider(stored.credentials).accessToken();
      return { ok: true, detail: "Google issued an access token for this service account." };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message.slice(0, 300) : "FCM authorization failed." };
    }
  }
  const stored = await webPushCredentials();
  if (!stored) {
    return { ok: false, detail: "Web Push is not connected." };
  }
  try {
    webpush.setVapidDetails(stored.credentials.subject, stored.credentials.publicKey, stored.credentials.privateKey);
    return { ok: true, detail: "VAPID key pair is valid." };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 300) : "Invalid VAPID keys." };
  }
}

// Re-exported for the provider registry.
export { APNsProvider };

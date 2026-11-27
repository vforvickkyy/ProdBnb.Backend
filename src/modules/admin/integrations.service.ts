import { env } from "../../config/env";
import { checkBucketAccess, getBucketCorsRules, originsMissingUpload } from "../../lib/r2";
import { browserUploadOrigins } from "../site/integrations.service";
import { adminClient, anonClient } from "../../lib/supabase";
import { checkApnsSigning } from "../notifications/providers/APNsProvider";
import { getPaymentProvider } from "../payments/providers";
import { getPlatformSettings } from "../platform/settings.service";

/**
 * Integrations & secrets status (Admin Console) -- "all APIs and secrets in one place", STATUS ONLY.
 *
 * The decision recorded for this feature: secret VALUES never leave the environment they live in
 * (Vercel's per-project env store). This endpoint reports, per integration, which keys are set,
 * whether the backend parsed them, and -- on request -- whether the live service actually accepts
 * them. Editing stays in Vercel; the Admin Panel links there.
 *
 * What a setting row may carry, by classification:
 *   secret      `set` only. Never a value, never a fragment, never a length.
 *   identifier  `set` + a masked hint (last 4 characters) -- enough to tell two keys apart, not
 *               enough to use one. App ids, account ids, key ids.
 *   public      the value itself. URLs, bucket names, environment names, provider choices --
 *               things already visible to any client or in any network trace.
 */

type SettingKind = "secret" | "identifier" | "public";

export interface IntegrationSetting {
  key: string;
  kind: SettingKind;
  set: boolean;
  /** Present only for `public` (full value) and `identifier` (masked) settings. */
  display: string | null;
}

export type CheckStatus = "ok" | "warning" | "error" | "disabled" | "unchecked";

export interface IntegrationStatus {
  id: string;
  name: string;
  purpose: string;
  status: CheckStatus;
  detail: string;
  latency_ms: number | null;
  settings: IntegrationSetting[];
}

export interface IntegrationsReport {
  checked_at: string;
  live_checks: boolean;
  deployment: {
    node_env: string;
    vercel_env: string | null;
    region: string | null;
    commit_sha: string | null;
    commit_ref: string | null;
    commit_message: string | null;
    deployment_url: string | null;
  };
  integrations: IntegrationStatus[];
}

function mask(value: string | undefined): string | null {
  if (!value) return null;
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}

function setting(key: string, kind: SettingKind, value: string | number | undefined | null): IntegrationSetting {
  const raw = value === undefined || value === null ? undefined : String(value);
  const set = raw !== undefined && raw.length > 0;
  const display = !set ? null : kind === "public" ? raw! : kind === "identifier" ? mask(raw) : null;
  return { key, kind, set, display };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; ms: number }> {
  const start = Date.now();
  try {
    const value = await fn();
    return { value, ms: Date.now() - start };
  } catch (error) {
    return { error, ms: Date.now() - start };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function errorText(error: unknown): string {
  // Error messages from these SDKs name the failure, never the credential -- but cap the length so a
  // verbose upstream message can never turn this report into a dump.
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

const CHECK_TIMEOUT_MS = 5000;

/** How to switch phone login on, shown while it is off. The SMS keys live in Supabase only. */
export const PHONE_LOGIN_SETUP =
  "Off. To switch it on: Supabase dashboard → Authentication → Sign In / Providers → Phone → enable, " +
  "then Authentication → Hooks → Send SMS hook → HTTPS → <API address>/v1/auth/sms-hook, and put its secret in the backend's " +
  "AUTH_SMS_HOOK_SECRET. Codes then go through Messaging → SMS (any provider, test mode before DLT). " +
  "Do it in both heken-staging and heken-production. The apps and website start offering it straight away.";

interface AuthSettings {
  external?: Record<string, boolean>;
  sms_provider?: string;
}

/** What Supabase Auth's public settings say about phone login. */
export function describePhoneLogin(settings: AuthSettings): { status: CheckStatus; detail: string } {
  if (settings.external?.phone) {
    const provider = settings.sms_provider ? ` through ${settings.sms_provider}` : "";
    return { status: "ok", detail: `On: people can log in and verify their number by SMS code${provider}.` };
  }
  return { status: "disabled", detail: PHONE_LOGIN_SETUP };
}

/**
 * Phone login status, read from Supabase Auth's public settings endpoint (the same one every
 * client can read). Cheap, so it runs on every report rather than only on "Run checks".
 */
async function phoneLoginStatus(): Promise<IntegrationStatus> {
  const base = { id: "phone-login", name: "Phone login (SMS)", purpose: "Log in and verify numbers with an SMS code", settings: [] };
  const result = await timed(async () => {
    const response = await withTimeout(
      fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/settings`, { headers: { apikey: env.SUPABASE_ANON_KEY } }),
      CHECK_TIMEOUT_MS
    );
    if (!response.ok) throw new Error(`Supabase answered ${response.status}`);
    return (await response.json()) as AuthSettings;
  });
  if (result.error || !result.value) {
    return { ...base, status: "warning", detail: `Couldn't read Supabase's login settings: ${errorText(result.error)}`, latency_ms: result.ms };
  }
  return { ...base, ...describePhoneLogin(result.value), latency_ms: result.ms };
}

export async function getIntegrationsReport(liveChecks: boolean): Promise<IntegrationsReport> {
  const integrations: IntegrationStatus[] = [];

  // -- Supabase ---------------------------------------------------------------------------------
  {
    const settings = [
      setting("SUPABASE_URL", "public", env.SUPABASE_URL),
      setting("SUPABASE_ANON_KEY", "identifier", env.SUPABASE_ANON_KEY),
      setting("SUPABASE_SERVICE_ROLE_KEY", "secret", env.SUPABASE_SERVICE_ROLE_KEY),
    ];
    let status: CheckStatus = "unchecked";
    let detail = "Configured. Run checks to test connectivity.";
    let latency: number | null = null;
    if (liveChecks) {
      const result = await timed(async () => {
        const [anon, service] = await Promise.all([
          withTimeout(Promise.resolve(anonClient.from("categories").select("id").limit(1)), CHECK_TIMEOUT_MS),
          withTimeout(Promise.resolve(adminClient.from("platform_settings").select("id").limit(1)), CHECK_TIMEOUT_MS),
        ]);
        if (anon.error) throw new Error(`Anon key: ${anon.error.message}`);
        if (service.error) throw new Error(`Service role key: ${service.error.message}`);
      });
      latency = result.ms;
      status = result.error ? "error" : "ok";
      detail = result.error ? errorText(result.error) : "Database reachable with both the anon and service-role keys.";
    }
    integrations.push({ id: "supabase", name: "Supabase", purpose: "Database, authentication, realtime", status, detail, latency_ms: latency, settings });
  }

  // -- Cloudflare R2 ----------------------------------------------------------------------------
  {
    const settings = [
      setting("R2_ACCOUNT_ID", "identifier", env.R2_ACCOUNT_ID),
      setting("R2_BUCKET_NAME", "public", env.R2_BUCKET_NAME),
      setting("R2_PUBLIC_BASE_URL", "public", env.R2_PUBLIC_BASE_URL),
      setting("R2_ACCESS_KEY_ID", "secret", env.R2_ACCESS_KEY_ID),
      setting("R2_SECRET_ACCESS_KEY", "secret", env.R2_SECRET_ACCESS_KEY),
      setting("R2_UPLOAD_URL_EXPIRY_SECONDS", "public", env.R2_UPLOAD_URL_EXPIRY_SECONDS),
      setting("MEDIA_MAX_PHOTO_SIZE_MB", "public", env.MEDIA_MAX_PHOTO_SIZE_MB),
      setting("MEDIA_MAX_VIDEO_SIZE_MB", "public", env.MEDIA_MAX_VIDEO_SIZE_MB),
    ];
    let status: CheckStatus = "unchecked";
    let detail = "Configured. Run checks to test bucket access.";
    let latency: number | null = null;
    if (liveChecks) {
      const result = await timed(() => withTimeout(checkBucketAccess(), CHECK_TIMEOUT_MS));
      latency = result.ms;
      status = result.error ? "error" : "ok";
      detail = result.error ? `Bucket not reachable: ${errorText(result.error)}` : `Bucket "${env.R2_BUCKET_NAME}" reachable with these credentials.`;
    }
    integrations.push({ id: "r2", name: "Cloudflare R2", purpose: "Listing photo & video storage", status, detail, latency_ms: latency, settings });
  }

  // -- R2 browser uploads (CORS) -- Admin Console 2 ----------------------------------------------
  {
    const settings = [setting("CORS_ORIGINS", "public", env.CORS_ORIGINS.join(", "))];
    let status: CheckStatus = "unchecked";
    let detail = "Run checks to confirm the Admin Console can upload photos straight to R2.";
    let latency: number | null = null;
    if (liveChecks) {
      const result = await timed(() => withTimeout(getBucketCorsRules(), CHECK_TIMEOUT_MS));
      latency = result.ms;
      if (result.error) {
        status = "error";
        detail = `Could not read the bucket's CORS rules: ${errorText(result.error)}`;
      } else if (env.CORS_ORIGINS.length === 0) {
        status = "error";
        detail = "CORS_ORIGINS is empty, so there is no browser origin to allow.";
      } else {
        const origins = await browserUploadOrigins();
        const missing = originsMissingUpload(result.value ?? [], origins);
        status = missing.length === 0 ? "ok" : "error";
        detail =
          missing.length === 0
            ? "Browser uploads are allowed from the admin console and the website."
            : `Photo uploads from ${missing.join(", ")} will fail: the bucket does not allow them yet. Use "Allow browser uploads".`;
      }
    }
    integrations.push({
      id: "r2_cors",
      name: "R2 browser uploads",
      purpose: "Admin Console photo & cover uploads",
      status,
      detail,
      latency_ms: latency,
      settings,
    });
  }

  // -- Payments (Cashfree) ----------------------------------------------------------------------
  {
    const settings = [
      setting("PAYMENT_PROVIDER", "public", env.PAYMENT_PROVIDER),
      setting("CASHFREE_ENV", "public", env.CASHFREE_ENV),
      setting("CASHFREE_API_VERSION", "public", env.CASHFREE_API_VERSION),
      setting("CASHFREE_APP_ID", "identifier", env.CASHFREE_APP_ID),
      setting("CASHFREE_SECRET_KEY", "secret", env.CASHFREE_SECRET_KEY),
    ];
    let status: CheckStatus = "unchecked";
    let detail = `Configured (${env.CASHFREE_ENV} mode — production payments are not enabled in code yet).`;
    let latency: number | null = null;
    if (liveChecks) {
      const provider = getPaymentProvider();
      if (!provider.checkCredentials) {
        status = "warning";
        detail = "This payment provider has no credential check.";
      } else {
        const result = await timed(() => withTimeout(provider.checkCredentials!(), CHECK_TIMEOUT_MS));
        latency = result.ms;
        if (result.error) {
          status = "error";
          detail = `Cashfree not reachable: ${errorText(result.error)}`;
        } else {
          status = result.value!.ok ? (env.CASHFREE_ENV === "test" ? "warning" : "ok") : "error";
          detail = result.value!.ok && env.CASHFREE_ENV === "test" ? `${result.value!.detail} Test mode: no real money moves.` : result.value!.detail;
        }
      }
    }
    integrations.push({ id: "cashfree", name: "Cashfree", purpose: "Booking payments & refunds", status, detail, latency_ms: latency, settings });
  }

  // -- Payment webhooks -------------------------------------------------------------------------
  {
    const settings = [setting("API_BASE_URL", "public", env.API_BASE_URL)];
    const local = /localhost|127\.0\.0\.1/.test(env.API_BASE_URL);
    const https = env.API_BASE_URL.startsWith("https://");
    let status: CheckStatus = local || !https ? "warning" : "unchecked";
    let detail = local
      ? "API_BASE_URL points at localhost: Cashfree can never deliver payment webhooks, so payments will not reconcile."
      : !https
        ? "API_BASE_URL is not HTTPS."
        : `Webhooks are delivered to ${env.API_BASE_URL}/v1/payments/webhooks/cashfree.`;
    if (liveChecks) {
      const { data, error } = await adminClient
        .from("payment_webhook_events")
        .select("received_at")
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        status = "error";
        detail = errorText(error);
      } else if (!local && https) {
        status = data ? "ok" : "warning";
        detail = data
          ? `${detail} Last webhook received ${new Date(data.received_at).toISOString()}.`
          : `${detail} No webhook has ever been received — make a test payment to confirm delivery.`;
      }
    }
    integrations.push({ id: "webhooks", name: "Payment webhooks", purpose: "How payments get confirmed", status, detail, latency_ms: null, settings });
  }

  // -- Push notifications (APNs) ----------------------------------------------------------------
  {
    const settings = [
      setting("NOTIFICATION_PROVIDER", "public", env.NOTIFICATION_PROVIDER),
      setting("APNS_ENVIRONMENT", "public", env.APNS_ENVIRONMENT),
      setting("APNS_BUNDLE_ID", "public", env.APNS_BUNDLE_ID),
      setting("APNS_TEAM_ID", "identifier", env.APNS_TEAM_ID),
      setting("APNS_KEY_ID", "identifier", env.APNS_KEY_ID),
      setting("APNS_PRIVATE_KEY", "secret", env.APNS_PRIVATE_KEY),
    ];
    let status: CheckStatus = env.NOTIFICATION_PROVIDER === "disabled" ? "disabled" : "unchecked";
    let detail =
      env.NOTIFICATION_PROVIDER === "disabled"
        ? "Push is off. In-app notifications still work; push attempts are recorded as skipped."
        : `APNs ${env.APNS_ENVIRONMENT}. Run checks to test the signing key.`;
    if (liveChecks && env.NOTIFICATION_PROVIDER === "apns") {
      const result = checkApnsSigning();
      status = result.ok ? "ok" : "error";
      detail = `${result.detail} (${env.APNS_ENVIRONMENT}; delivery itself can only be proven with a real device.)`;
    }
    integrations.push({ id: "apns", name: "Apple Push (APNs)", purpose: "iOS push notifications", status, detail, latency_ms: null, settings });
  }

  // -- Phone login (SMS) ------------------------------------------------------------------------
  integrations.push(await phoneLoginStatus());

  // -- Platform rules -------------------------------------------------------------------------
  {
    const platform = await getPlatformSettings({ fresh: true });
    const settings = [
      setting("CORS_ORIGINS", "public", env.CORS_ORIGINS.join(", ")),
      setting("NODE_ENV", "public", env.NODE_ENV),
    ];
    const holds = platform.unpaid_hold_minutes === null ? "off" : `${platform.unpaid_hold_minutes} min`;
    integrations.push({
      id: "platform",
      name: "Platform rules",
      purpose: "Browser access, fees and unpaid-hold expiry",
      status: env.CORS_ORIGINS.length === 0 ? "warning" : "ok",
      detail:
        `${env.CORS_ORIGINS.length} allowed browser origin(s). Platform fee ${platform.platform_fee_bps / 100}%, ` +
        `tax ${platform.tax_bps / 100}%, unpaid-hold expiry ${holds}. Rate limiting is per server instance.`,
      latency_ms: null,
      settings,
    });
  }

  return {
    checked_at: new Date().toISOString(),
    live_checks: liveChecks,
    deployment: {
      node_env: env.NODE_ENV,
      vercel_env: process.env.VERCEL_ENV ?? null,
      region: process.env.VERCEL_REGION ?? null,
      commit_sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      commit_ref: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      commit_message: process.env.VERCEL_GIT_COMMIT_MESSAGE?.split("\n")[0]?.slice(0, 200) ?? null,
      deployment_url: process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
    },
    integrations,
  };
}

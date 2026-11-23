import { createSign } from "crypto";
import * as http2 from "http2";
import { env } from "../../../config/env";
import { DeliveryStatus, NotificationProvider, SendPushInput, SendPushResult } from "./NotificationProvider";

// Apple's two APNs hosts. Under token (.p8) authentication the SAME credential
// works against both -- sandbox and production differ only by host, never by
// key -- so this is a lookup table, not configuration.
//
// PHASE 27-8 ADDED THE PRODUCTION ENTRY AS CODE SUPPORT ONLY. Production APNs
// remains deliberately UNCONFIGURED: env.APNS_ENVIRONMENT's schema
// (src/config/env.ts) still accepts only "sandbox", there are no production
// credentials, and nothing selects the production host unless a DEVICE
// registered itself as `production`. Turning production on is a conscious,
// separate change to that schema plus real Apple configuration -- never a
// silent flip.
const HOSTS: Record<string, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

// Reasons Apple documents specifically for a token that will never work
// again -- these, and only these, flip the owning user_devices row to
// is_active = false. Everything else non-200 is a generic `failed`
// (misconfiguration, rate limiting, a transient provider issue), which
// this phase records but does not retry (see docs/DATABASE.md).
const INVALID_TOKEN_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Signs Apple's provider-authentication JWT (ES256, header {alg, kid},
 * claims {iss, iat}) -- built with node:crypto's raw ECDSA signing
 * (dsaEncoding: "ieee-p1363" produces the raw R||S concatenation ES256
 * JWTs require, not the ASN.1 DER crypto.sign() emits by default).
 */
function signApnsJwt(teamId: string, keyId: string, privateKeyPem: string): string {
  const header = base64url(Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId })));
  const claims = base64url(Buffer.from(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) })));
  const signingInput = `${header}.${claims}`;

  const signature = createSign("SHA256").update(signingInput).sign({ key: privateKeyPem, dsaEncoding: "ieee-p1363" });

  return `${signingInput}.${base64url(signature)}`;
}

// Apple recommends reusing a provider token for up to ~1 hour rather than
// signing a fresh one per request -- a small in-memory cache, not a queue.
/**
 * Admin Console 2: credentials are an object rather than four env reads, so the same provider runs
 * on either source -- the dashboard-connected key (Supabase Vault, `messaging_channels`) or the
 * original APNS_* environment variables.
 */
export interface ApnsCredentials {
  teamId: string;
  keyId: string;
  bundleId: string;
  privateKey: string;
  /** Host used for a device that did not record its own environment. */
  defaultEnvironment: "sandbox" | "production";
}

export function apnsCredentialsFromEnv(): ApnsCredentials {
  return {
    teamId: requireConfig("APNS_TEAM_ID"),
    keyId: requireConfig("APNS_KEY_ID"),
    bundleId: requireConfig("APNS_BUNDLE_ID"),
    privateKey: requireConfig("APNS_PRIVATE_KEY"),
    defaultEnvironment: env.APNS_ENVIRONMENT,
  };
}

const JWT_MAX_AGE_MS = 50 * 60 * 1000;

function requireConfig(key: "APNS_TEAM_ID" | "APNS_KEY_ID" | "APNS_BUNDLE_ID" | "APNS_PRIVATE_KEY"): string {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is required when NOTIFICATION_PROVIDER=apns.`);
  }
  return value;
}

function mapApnsResponse(status: number, reason: string | undefined): DeliveryStatus {
  if (status === 200) {
    return "sent";
  }
  if (reason && INVALID_TOKEN_REASONS.has(reason)) {
    return "invalid_token";
  }
  return "failed";
}

export class APNsProvider implements NotificationProvider {
  readonly name = "apns" as const;

  /** The process-wide default, used when a device did not record its own environment. */
  private readonly defaultHost: string;
  private readonly credentials: ApnsCredentials;
  private cachedJwt: { token: string; issuedAt: number } | null = null;

  // Fails fast at construction time (missing env config throws in apnsCredentialsFromEnv), not on
  // the first send.
  constructor(credentials: ApnsCredentials = apnsCredentialsFromEnv()) {
    const host = HOSTS[credentials.defaultEnvironment];
    if (!host) {
      throw new Error(`No APNs host configured for environment '${credentials.defaultEnvironment}'.`);
    }
    this.defaultHost = host;
    this.credentials = credentials;
  }

  /** Apple's provider token, re-signed every 50 minutes (Apple rejects tokens older than an hour). */
  jwt(): string {
    if (this.cachedJwt && Date.now() - this.cachedJwt.issuedAt < JWT_MAX_AGE_MS) {
      return this.cachedJwt.token;
    }
    const token = signApnsJwt(this.credentials.teamId, this.credentials.keyId, this.credentials.privateKey);
    this.cachedJwt = { token, issuedAt: Date.now() };
    return token;
  }

  /**
   * Chooses the APNs host PER DEVICE (Phase 27-8), not once per process.
   *
   * An APNs device token belongs to exactly one environment -- decided by the
   * `aps-environment` entitlement in the build that produced it -- and iOS
   * records which one in `user_devices.environment`. Before this phase that
   * value was passed to send() and IGNORED: every push went to whatever
   * env.APNS_ENVIRONMENT said.
   *
   * That is harmless while only sandbox exists, and becomes a real bug the
   * moment production tokens appear. One user can legitimately hold a
   * TestFlight (sandbox) token and an App Store (production) token at the same
   * time, and a single fan-out must reach both. Sending a token to the wrong
   * host returns `DeviceTokenNotForTopic`, which mapApnsResponse() classifies
   * as `invalid_token` -- so the old behaviour would have DEACTIVATED a
   * perfectly good device rather than delivering to it.
   *
   * A null/unknown environment falls back to the configured default, so every
   * device registered before this phase behaves exactly as it did.
   */
  private hostFor(environment: SendPushInput["environment"]): string {
    return (environment && HOSTS[environment]) || this.defaultHost;
  }

  async send(input: SendPushInput): Promise<SendPushResult> {
    const payload = JSON.stringify(buildApnsPayload(input));

    const session = http2.connect(this.hostFor(input.environment));
    try {
      const result = await new Promise<SendPushResult>((resolve, reject) => {
        const stream = session.request({
          ":method": "POST",
          ":path": `/3/device/${encodeURIComponent(input.deviceToken)}`,
          authorization: `bearer ${this.jwt()}`,
          "apns-topic": this.credentials.bundleId,
          "apns-push-type": "alert",
          "content-type": "application/json",
        });

        let status = 0;
        let apnsId: string | null = null;
        const chunks: Buffer[] = [];

        stream.on("response", (headers) => {
          status = Number(headers[":status"] ?? 0);
          const idHeader = headers["apns-id"];
          apnsId = typeof idHeader === "string" ? idHeader : null;
        });
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          let reason: string | undefined;
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined;
          } catch {
            reason = undefined;
          }
          const mapped = mapApnsResponse(status, reason);
          resolve({
            status: mapped,
            providerMessageId: apnsId,
            errorReason: mapped === "sent" ? null : (reason ?? `HTTP ${status}`),
          });
        });
        stream.on("error", (err) => reject(err));

        stream.end(payload);
      });
      return result;
    } catch (err) {
      return { status: "failed", providerMessageId: null, errorReason: err instanceof Error ? err.message : "Unknown APNs error." };
    } finally {
      session.close();
    }
  }
}

/**
 * Admin Console integrations check: can the configured key actually sign an APNs provider token?
 * Proves the key, team id and key id are usable together; it cannot prove Apple will accept a
 * push (that needs a real device token). Never returns or logs the key or the token.
 */
export function checkApnsSigning(credentials?: ApnsCredentials): { ok: boolean; detail: string } {
  try {
    new APNsProvider(credentials ?? apnsCredentialsFromEnv()).jwt();
    return { ok: true, detail: "Provider token signed successfully with the configured key." };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 200) : "Signing failed." };
  }
}

/**
 * The JSON body APNs receives. Optional parts are only emitted when the caller supplied them, so a
 * push that sets none of them carries the same `aps` object as before.
 *
 *  - `thread-id` groups a conversation (or a booking) into one stack in the notification centre.
 *  - `category` makes iOS show the app's action buttons (Reply, View booking).
 *  - `badge` sets the number on the app icon to the unread count (0 clears it).
 *  - `interruption-level` lets a new booking request through a Focus.
 */
export function buildApnsPayload(input: SendPushInput): Record<string, unknown> {
  return {
    aps: {
      alert: { title: input.title, body: input.body },
      sound: "default",
      ...(input.threadId ? { "thread-id": input.threadId } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(typeof input.badge === "number" && input.badge >= 0 ? { badge: Math.floor(input.badge) } : {}),
      ...(input.interruptionLevel ? { "interruption-level": input.interruptionLevel } : {}),
    },
    ...input.data,
  };
}


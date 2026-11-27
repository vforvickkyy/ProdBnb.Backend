import { createSign } from "crypto";
import { NotificationProvider, SendPushInput, SendPushResult } from "./NotificationProvider";

/**
 * Android push through Firebase Cloud Messaging's HTTP v1 API (Admin Console 2).
 *
 * Authenticates as a Google service account: a self-signed RS256 JWT is exchanged at Google's
 * OAuth token endpoint for a one-hour access token, cached per provider instance. No Firebase SDK
 * -- this is the documented REST flow, two HTTPS calls, using node:crypto for the signature.
 */
export interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Parse a downloaded service-account JSON into the three fields FCM needs. */
export function parseServiceAccount(json: string): FcmCredentials {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error("That is not valid JSON. Paste the whole service-account file you downloaded from Firebase.");
  }
  const projectId = parsed.project_id;
  const clientEmail = parsed.client_email;
  const privateKey = parsed.private_key;
  if (parsed.type !== "service_account" || typeof projectId !== "string" || typeof clientEmail !== "string" || typeof privateKey !== "string") {
    throw new Error("The JSON must be a Firebase service-account key (type, project_id, client_email, private_key).");
  }
  return { projectId, clientEmail, privateKey };
}

export class FCMProvider implements NotificationProvider {
  readonly name = "fcm" as const;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly credentials: FcmCredentials) {}

  private signAssertion(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(
      JSON.stringify({ iss: this.credentials.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })
    );
    const input = `${header}.${claims}`;
    const signature = createSign("RSA-SHA256").update(input).sign(this.credentials.privateKey);
    return `${input}.${base64url(signature)}`;
  }

  async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) {
      return this.token.value;
    }
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: this.signAssertion(),
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!response.ok || !body.access_token) {
      throw new Error(`Google rejected the service account: ${body.error_description ?? `HTTP ${response.status}`}`);
    }
    // Refresh five minutes early.
    this.token = { value: body.access_token, expiresAt: Date.now() + ((body.expires_in ?? 3600) - 300) * 1000 };
    return body.access_token;
  }

  async send(input: SendPushInput): Promise<SendPushResult> {
    try {
      const token = await this.accessToken();
      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.credentials.projectId)}/messages:send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token: input.deviceToken,
            notification: { title: input.title, body: input.body },
            data: input.data,
            android: {
              priority: "HIGH",
              notification: { sound: "default", channel_id: androidChannelFor(input.category), ...(input.threadId ? { tag: input.threadId } : {}) },
            },
          },
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        name?: string;
        error?: { status?: string; message?: string; details?: { errorCode?: string }[] };
      };
      if (response.ok) {
        return { status: "sent", providerMessageId: body.name ?? null, errorReason: null };
      }
      const code = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status ?? `HTTP ${response.status}`;
      // UNREGISTERED: the app was uninstalled / token rotated. INVALID_ARGUMENT on a token is the
      // same thing for a malformed token. Either way the device should be deactivated.
      const invalid = code === "UNREGISTERED" || (code === "INVALID_ARGUMENT" && /token/i.test(body.error?.message ?? ""));
      return { status: invalid ? "invalid_token" : "failed", providerMessageId: null, errorReason: code };
    } catch (error) {
      return { status: "failed", providerMessageId: null, errorReason: error instanceof Error ? error.message.slice(0, 200) : "FCM error" };
    }
  }
}

/** The Android app's notification channels (co.heken.app PushChannels): people can mute each kind. */
export function androidChannelFor(category: string | null | undefined): "messages" | "bookings" | "general" {
  if (category === "PRODBNB_MESSAGE") return "messages";
  if (category === "PRODBNB_BOOKING") return "bookings";
  return "general";
}

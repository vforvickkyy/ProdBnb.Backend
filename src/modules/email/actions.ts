import { createHmac, timingSafeEqual } from "crypto";
import { adminClient } from "../../lib/supabase";
import { siteUrl } from "./layout";

/**
 * "Accept" / "Decline" straight from a host's booking-request email.
 *
 * The button opens a confirm page on the website (`/email-action/<token>`), never an action on a
 * GET: mail scanners open every link, and must not accept a booking on the host's behalf. The page
 * shows the booking and posts back to the API, which checks the token and that the booking still
 * needs an answer. The token is signed (HMAC), names one booking, one host and one action, and
 * expires; using it twice is harmless because a booking can only be answered once.
 */

export type EmailAction = "accept" | "decline";

interface Claims {
  b: string; // booking id
  h: string; // host id
  a: EmailAction;
  e: number; // expiry, unix seconds
}

const TTL_SECONDS = 7 * 24 * 3600;
let key: Buffer | null = null;

async function signingKey(): Promise<Buffer> {
  if (key) return key;
  const { data, error } = await adminClient.rpc("system_secret", { _name: "prodbnb_unsubscribe_key" });
  if (error || typeof data !== "string" || data.length < 32) {
    throw error ?? new Error("Signing key is missing.");
  }
  // Domain-separated from the unsubscribe links signed with the same secret.
  key = createHmac("sha256", data).update("email-action:v1").digest();
  return key;
}

/** Tests only. */
export function setEmailActionKeyForTesting(value: string | null): void {
  key = value ? createHmac("sha256", value).update("email-action:v1").digest() : null;
}

const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");

export async function signEmailAction(bookingId: string, hostId: string, action: EmailAction, now = Date.now()): Promise<string> {
  const claims: Claims = { b: bookingId, h: hostId, a: action, e: Math.floor(now / 1000) + TTL_SECONDS };
  const body = b64(JSON.stringify(claims));
  const sig = createHmac("sha256", await signingKey()).update(body).digest();
  return `${body}.${b64(sig)}`;
}

export async function verifyEmailAction(token: string, now = Date.now()): Promise<Claims | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig || token.length > 600) return null;
  const expected = createHmac("sha256", await signingKey()).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Claims;
    if (claims.a !== "accept" && claims.a !== "decline") return null;
    if (typeof claims.e !== "number" || claims.e * 1000 < now) return null;
    return claims;
  } catch {
    return null;
  }
}

export async function emailActionUrl(bookingId: string, hostId: string, action: EmailAction): Promise<string> {
  return siteUrl(`/email-action/${await signEmailAction(bookingId, hostId, action)}`);
}

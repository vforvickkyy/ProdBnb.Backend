import { createHmac, timingSafeEqual } from "crypto";
import { Request, Response } from "express";
import { env } from "../../config/env";
import { adminClient } from "../../lib/supabase";

/**
 * Resend -> us: bounces and spam complaints (Resend dashboard -> Webhooks, events
 * `email.bounced` and `email.complained`, URL <api>/v1/webhooks/resend).
 *
 * A hard bounce blocks the address for every email (it doesn't exist, so more sends only hurt
 * our sender reputation); a complaint ("mark as spam") unsubscribes it from news and offers.
 * Booking emails still go to someone who complained: they asked for those.
 *
 * Resend signs with Svix: HMAC-SHA256 over `<svix-id>.<svix-timestamp>.<raw body>`, keyed with
 * the base64 part of the `whsec_...` secret. Requests older than 5 minutes are refused.
 */

const TOLERANCE_SECONDS = 5 * 60;

export function verifySvixSignature(secret: string, headers: { id?: string; timestamp?: string; signature?: string }, body: string, now = Date.now()): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  return signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

interface ResendEvent {
  type?: string;
  data?: { to?: string[] | string; bounce?: { type?: string } };
}

let secretOverride: string | null | undefined;
/** Tests only. */
export function setResendWebhookSecretForTesting(value: string | null | undefined): void {
  secretOverride = value;
}

export async function postResendWebhook(req: Request, res: Response): Promise<void> {
  const secret = secretOverride !== undefined ? secretOverride : env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    res.status(503).json({ error: { code: "NOT_CONFIGURED", message: "Webhook secret isn't set." } });
    return;
  }
  const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const ok = verifySvixSignature(secret, {
    id: req.header("svix-id") ?? undefined,
    timestamp: req.header("svix-timestamp") ?? undefined,
    signature: req.header("svix-signature") ?? undefined,
  }, body);
  if (!ok) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Bad signature." } });
    return;
  }
  let event: ResendEvent;
  try {
    event = JSON.parse(body) as ResendEvent;
  } catch {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Not JSON." } });
    return;
  }
  const to = (Array.isArray(event.data?.to) ? event.data!.to : event.data?.to ? [event.data.to] : [])
    .map((e) => String(e).trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+$/.test(e));

  let reason: "bounced" | "unsubscribed" | null = null;
  if (event.type === "email.bounced" && (event.data?.bounce?.type ?? "Permanent").toLowerCase() !== "transient") reason = "bounced";
  if (event.type === "email.complained") reason = "unsubscribed";

  if (reason && to.length > 0) {
    for (const email of to) {
      // A bounce outranks an earlier unsubscribe; never downgrade a bounce to an unsubscribe.
      const { data: existing } = await adminClient.from("email_suppressions").select("reason").eq("email", email).maybeSingle();
      if (existing?.reason === "bounced" || existing?.reason === reason) continue;
      const { data: user } = await adminClient.rpc("admin_find_user_id_by_email", { _email: email });
      await adminClient
        .from("email_suppressions")
        .upsert({ email, reason, user_id: typeof user === "string" ? user : null }, { onConflict: "email" });
    }
  }
  res.status(200).json({ data: { received: true } });
}

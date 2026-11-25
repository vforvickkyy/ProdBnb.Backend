import { createHmac, timingSafeEqual } from "crypto";
import { Request, Response } from "express";
import { env } from "../../config/env";
import { adminClient } from "../../lib/supabase";

/**
 * Resend -> us (Resend dashboard -> Webhooks, URL <api>/v1/webhooks/resend), events
 * `email.delivered`, `email.opened`, `email.clicked`, `email.bounced` and `email.complained`.
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
  created_at?: string;
  data?: { email_id?: string; to?: string[] | string; bounce?: { type?: string } };
}

/**
 * Delivery, opens and clicks, recorded on the email they belong to (matched by Resend's email id):
 * a campaign recipient (marketing: all five) or an outbox row (booking emails: delivered/bounced).
 * First time of each is kept; opens and clicks are also counted.
 */
async function recordEvent(event: ResendEvent): Promise<void> {
  const id = event.data?.email_id;
  if (!id) return;
  const at = event.created_at && !Number.isNaN(Date.parse(event.created_at)) ? new Date(event.created_at).toISOString() : new Date().toISOString();
  const column: Record<string, string> = {
    "email.delivered": "email_delivered_at",
    "email.opened": "email_opened_at",
    "email.clicked": "email_clicked_at",
    "email.bounced": "email_bounced_at",
    "email.complained": "email_complained_at",
  };
  const col = event.type ? column[event.type] : undefined;
  if (!col) return;
  const { data: rows } = await adminClient
    .from("campaign_recipients")
    .select("campaign_id, user_id, email_opened_at, email_clicked_at, email_delivered_at, email_bounced_at, email_complained_at, email_open_count, email_click_count")
    .eq("email_message_id", id)
    .limit(1);
  const r = (rows ?? [])[0] as Record<string, unknown> | undefined;
  if (r) {
    const update: Record<string, unknown> = {};
    if (!r[col]) update[col] = at;
    if (event.type === "email.opened") update.email_open_count = Number(r.email_open_count ?? 0) + 1;
    if (event.type === "email.clicked") {
      update.email_click_count = Number(r.email_click_count ?? 0) + 1;
      // A click means it was opened, even when the open pixel was blocked.
      if (!r.email_opened_at) update.email_opened_at = at;
    }
    if (Object.keys(update).length) {
      await adminClient.from("campaign_recipients").update(update).eq("campaign_id", r.campaign_id as string).eq("user_id", r.user_id as string);
    }
    return;
  }
  if (event.type === "email.delivered") {
    await adminClient.from("email_outbox").update({ delivered_at: at }).eq("provider_message_id", id).is("delivered_at", null);
  } else if (event.type === "email.bounced") {
    await adminClient.from("email_outbox").update({ bounced_at: at }).eq("provider_message_id", id).is("bounced_at", null);
  }
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

  await recordEvent(event).catch((error) => console.error("Resend event not recorded:", error));

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

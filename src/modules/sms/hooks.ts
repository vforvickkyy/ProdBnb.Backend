import { Request, Response } from "express";
import { timingSafeEqual } from "crypto";
import { env } from "../../config/env";
import { verifySvixSignature } from "../email/resendWebhook";
import { applyDeliveryReports, sendAuthCode, SmsCodeError } from "./outbox.service";
import { isProviderId, PROVIDERS } from "./providers";
import { smsSettings } from "./settings.service";

/**
 * Supabase "Send SMS" hook (Supabase -> Authentication -> Hooks): every sign-in and phone
 * verification code goes through our SMS system instead of Supabase's built-in providers, so the
 * provider chosen in the admin sends codes too. Signed like the email hook (Standard Webhooks);
 * the secret goes in AUTH_SMS_HOOK_SECRET.
 */

interface SmsHookPayload {
  user?: { id?: string; phone?: string };
  sms?: { otp?: string };
}

let secretOverride: string | null | undefined;
/** Tests only. */
export function setSmsHookSecretForTesting(secret: string | null | undefined): void {
  secretOverride = secret;
}

export async function postAuthSmsHook(req: Request, res: Response): Promise<void> {
  const raw = secretOverride !== undefined ? secretOverride : env.AUTH_SMS_HOOK_SECRET;
  if (!raw) {
    res.status(503).json({ error: { http_code: 503, message: "SMS hook secret isn't set." } });
    return;
  }
  const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const ok = verifySvixSignature(raw.replace(/^v1,/, ""), {
    id: req.header("webhook-id") ?? undefined,
    timestamp: req.header("webhook-timestamp") ?? undefined,
    signature: req.header("webhook-signature") ?? undefined,
  }, body);
  if (!ok) {
    res.status(401).json({ error: { http_code: 401, message: "Bad signature." } });
    return;
  }
  let payload: SmsHookPayload;
  try {
    payload = JSON.parse(body) as SmsHookPayload;
  } catch {
    res.status(400).json({ error: { http_code: 400, message: "Not JSON." } });
    return;
  }
  const phone = payload.user?.phone ?? "";
  const code = payload.sms?.otp ?? "";
  if (!phone || !/^[0-9]{4,10}$/.test(code)) {
    res.status(400).json({ error: { http_code: 400, message: "Missing phone or code." } });
    return;
  }
  try {
    await sendAuthCode({
      phone: phone.startsWith("+") ? phone : `+${phone}`,
      code,
      userId: payload.user?.id ?? null,
      hookId: req.header("webhook-id") ?? crypto.randomUUID(),
    });
    res.status(200).json({});
  } catch (error) {
    const status = error instanceof SmsCodeError ? error.httpStatus : 500;
    const message = error instanceof Error ? error.message : "The code couldn't be sent.";
    res.status(status).json({ error: { http_code: status, message } });
  }
}

/**
 * Delivery reports: POST (or GET) /v1/webhooks/sms/:provider?token=... -- the address shown in the
 * admin for the provider's dashboard. The token proves the call comes from someone we gave it to.
 * Always answers 200 for a good token so providers don't retry forever.
 */
export async function postSmsDeliveryReport(req: Request, res: Response): Promise<void> {
  const provider = String(req.params.provider ?? "");
  if (!isProviderId(provider)) {
    res.status(404).json({ error: "Unknown provider." });
    return;
  }
  const settings = await smsSettings();
  const given = Buffer.from(String(req.query.token ?? ""));
  const expected = Buffer.from(settings.webhook_token);
  if (!expected.length || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    res.status(401).json({ error: "Bad token." });
    return;
  }
  let payload: Record<string, unknown> = { ...(req.query as Record<string, unknown>) };
  delete payload.token;
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : typeof req.body === "string" ? req.body : "";
  if (raw) {
    const type = req.header("content-type") ?? "";
    if (type.includes("json")) {
      try {
        const parsed = JSON.parse(raw);
        payload = Array.isArray(parsed) ? { ...payload, data: parsed } : { ...payload, ...(parsed as Record<string, unknown>) };
      } catch {
        /* ignore */
      }
    } else {
      payload = { ...payload, ...Object.fromEntries(new URLSearchParams(raw)) };
    }
  }
  const reports = PROVIDERS[provider].parseReports(payload);
  const updated = reports.length ? await applyDeliveryReports(provider, reports) : 0;
  res.status(200).json({ received: reports.length, updated });
}

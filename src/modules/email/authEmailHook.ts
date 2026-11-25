import { Request, Response } from "express";
import { env } from "../../config/env";
import { adminClient } from "../../lib/supabase";
import { sendEmail } from "../outreach/email";
import { Block, renderLayout } from "./layout";
import { verifySvixSignature } from "./resendWebhook";
import type { EmailTemplate } from "./templates";

/**
 * Supabase "Send Email" hook (Supabase -> Authentication -> Hooks): sign-up confirmation, password
 * reset, sign-in links and codes, invites and email changes are sent by us, in the heken design,
 * instead of Supabase's plain defaults. Supabase signs each call (Standard Webhooks, same scheme
 * as Svix) with the hook secret, which goes in AUTH_EMAIL_HOOK_SECRET.
 *
 * These emails carry one-time links and codes, so they are sent at once and never stored: the
 * email log gets a row saying what was sent and whether it went, without the link. If sending
 * fails Supabase gets an error and the person can simply ask again.
 */

interface HookPayload {
  user?: { id?: string; email?: string; new_email?: string; user_metadata?: { first_name?: string; full_name?: string; name?: string } };
  email_data?: {
    token?: string;
    token_hash?: string;
    redirect_to?: string;
    email_action_type?: string;
    site_url?: string;
    token_new?: string;
    token_hash_new?: string;
  };
}

let secretOverride: string | null | undefined;
let senderOverride: typeof sendEmail | null = null;
/** Tests only. */
export function setAuthHookForTesting(secret: string | null | undefined, sender: typeof sendEmail | null = null): void {
  secretOverride = secret;
  senderOverride = sender;
}

function verifyUrl(tokenHash: string, type: string, redirectTo?: string): string {
  const base = env.SUPABASE_URL.replace(/\/$/, "");
  const params = new URLSearchParams({ token: tokenHash, type });
  if (redirectTo) params.set("redirect_to", redirectTo);
  return `${base}/auth/v1/verify?${params.toString()}`;
}

function firstName(p: HookPayload): string {
  const m = p.user?.user_metadata ?? {};
  const name = m.first_name || m.full_name || m.name || "";
  return name.trim().split(/\s+/)[0] || "there";
}

interface AuthEmail {
  to: string;
  template: EmailTemplate;
  subject: string;
  preheader: string;
  blocks: Block[];
}

const brand = () => env.BRAND_NAME;

/** What to send for one hook call (an email change can need two: old and new address). */
export function authEmailsFor(p: HookPayload): AuthEmail[] {
  const d = p.email_data ?? {};
  const type = d.email_action_type ?? "";
  const hi = `Hi ${firstName(p)},`;
  const email = p.user?.email ?? "";
  const expiry: Block = { kind: "text", muted: true, text: "This link works once and expires in 1 hour. If you didn't ask for it, ignore this email: nothing changes." };
  const code = (c?: string): Block[] => (c ? [{ kind: "code", code: c, label: "Or enter this code" }] : []);
  switch (type) {
    case "signup":
      return [{
        to: email,
        template: "auth_signup",
        subject: `Confirm your email for ${brand()}`,
        preheader: "One tap to confirm your email and finish signing up.",
        blocks: [
          { kind: "heading", text: "Confirm your email" },
          { kind: "text", text: `${hi} tap the button to confirm this is your email and finish signing up.` },
          { kind: "button", label: "Confirm email", url: verifyUrl(d.token_hash ?? "", "signup", d.redirect_to) },
          ...code(d.token),
          expiry,
        ],
      }];
    case "recovery":
      return [{
        to: email,
        template: "auth_recovery",
        subject: `Reset your ${brand()} password`,
        preheader: "Choose a new password.",
        blocks: [
          { kind: "heading", text: "Reset your password" },
          { kind: "text", text: `${hi} someone (hopefully you) asked to reset the password for ${email}. Tap below to choose a new one.` },
          { kind: "button", label: "Choose a new password", url: verifyUrl(d.token_hash ?? "", "recovery", d.redirect_to) },
          ...code(d.token),
          expiry,
        ],
      }];
    case "magiclink":
      return [{
        to: email,
        template: "auth_magiclink",
        subject: d.token ? `${d.token} is your ${brand()} sign-in code` : `Sign in to ${brand()}`,
        preheader: "Your sign-in link and code.",
        blocks: [
          { kind: "heading", text: "Sign in" },
          { kind: "text", text: `${hi} tap the button to sign in, or enter the code in the app.` },
          { kind: "button", label: `Sign in to ${brand()}`, url: verifyUrl(d.token_hash ?? "", "magiclink", d.redirect_to) },
          ...code(d.token),
          expiry,
        ],
      }];
    case "invite":
      return [{
        to: email,
        template: "auth_invite",
        subject: `You're invited to ${brand()}`,
        preheader: "Accept your invite and set up your account.",
        blocks: [
          { kind: "heading", text: `You're invited to ${brand()}` },
          { kind: "text", text: "Accept the invite to set up your account." },
          { kind: "button", label: "Accept invite", url: verifyUrl(d.token_hash ?? "", "invite", d.redirect_to) },
          expiry,
        ],
      }];
    case "email_change": {
      // Supabase: token_hash_new confirms from the current address, token_hash from the new one
      // (with "secure email change" both must be confirmed). Send whichever were given.
      const out: AuthEmail[] = [];
      const newEmail = p.user?.new_email ?? "";
      if (d.token_hash_new && email) {
        out.push({
          to: email,
          template: "auth_email_change",
          subject: `Confirm your email change on ${brand()}`,
          preheader: "Confirm you asked to change your email.",
          blocks: [
            { kind: "heading", text: "Confirm your email change" },
            { kind: "text", text: `${hi} confirm you want to change your email from ${email} to ${newEmail}.` },
            { kind: "button", label: "Confirm change", url: verifyUrl(d.token_hash_new, "email_change", d.redirect_to) },
            ...code(d.token_new),
            expiry,
          ],
        });
      }
      if (d.token_hash && newEmail) {
        out.push({
          to: newEmail,
          template: "auth_email_change",
          subject: `Confirm your new email for ${brand()}`,
          preheader: "Confirm this is your new email address.",
          blocks: [
            { kind: "heading", text: "Confirm your new email" },
            { kind: "text", text: `${hi} confirm ${newEmail} is your new email for ${brand()}.` },
            { kind: "button", label: "Confirm new email", url: verifyUrl(d.token_hash, "email_change", d.redirect_to) },
            ...code(d.token),
            expiry,
          ],
        });
      }
      return out;
    }
    case "reauthentication":
      return [{
        to: email,
        template: "auth_reauthentication",
        subject: `${d.token ?? "Your"} is your ${brand()} verification code`,
        preheader: "Your verification code.",
        blocks: [
          { kind: "heading", text: "Your verification code" },
          { kind: "text", text: `${hi} enter this code to confirm it's you.` },
          ...(d.token ? [{ kind: "code", code: d.token, label: "Your code" } as Block] : []),
          { kind: "text", muted: true, text: "It expires soon. If you didn't ask for it, change your password." },
        ],
      }];
    default:
      return [];
  }
}

export async function postAuthEmailHook(req: Request, res: Response): Promise<void> {
  const raw = secretOverride !== undefined ? secretOverride : env.AUTH_EMAIL_HOOK_SECRET;
  if (!raw) {
    res.status(503).json({ error: { http_code: 503, message: "Email hook secret isn't set." } });
    return;
  }
  const secret = raw.replace(/^v1,/, "");
  const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const ok = verifySvixSignature(secret, {
    id: req.header("webhook-id") ?? undefined,
    timestamp: req.header("webhook-timestamp") ?? undefined,
    signature: req.header("webhook-signature") ?? undefined,
  }, body);
  if (!ok) {
    res.status(401).json({ error: { http_code: 401, message: "Bad signature." } });
    return;
  }
  let payload: HookPayload;
  try {
    payload = JSON.parse(body) as HookPayload;
  } catch {
    res.status(400).json({ error: { http_code: 400, message: "Not JSON." } });
    return;
  }
  const emails = authEmailsFor(payload);
  if (emails.length === 0) {
    res.status(400).json({ error: { http_code: 400, message: `Unknown email type: ${payload.email_data?.email_action_type ?? "none"}` } });
    return;
  }
  const send = senderOverride ?? sendEmail;
  const hookId = req.header("webhook-id") ?? crypto.randomUUID();
  for (const [i, e] of emails.entries()) {
    const rendered = renderLayout({ subject: e.subject, preheader: e.preheader, blocks: e.blocks, footerNote: `You're getting this because of a sign-in request on ${brand()}.` });
    let status: "sent" | "failed" = "sent";
    let messageId: string | null = null;
    let error: string | null = null;
    try {
      messageId = await send({ to: e.to, subject: rendered.subject, html: rendered.html, text: rendered.text, tags: { kind: e.template } });
    } catch (err) {
      status = "failed";
      error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    }
    // The log row never holds the link or code.
    await adminClient
      .from("email_outbox")
      .insert({
        user_id: null,
        to_email: e.to,
        template: e.template,
        idempotency_key: `auth:${hookId}:${i}`,
        data: { action: payload.email_data?.email_action_type ?? null },
        subject: rendered.subject,
        status,
        attempts: 1,
        last_error: error,
        provider_message_id: messageId,
        sent_at: status === "sent" ? new Date().toISOString() : null,
      })
      .then(({ error: logError }) => {
        if (logError && logError.code !== "23505") console.error("Auth email not logged:", logError);
      });
    if (status === "failed") {
      res.status(500).json({ error: { http_code: 500, message: `The email couldn't be sent: ${error}` } });
      return;
    }
  }
  res.status(200).json({});
}

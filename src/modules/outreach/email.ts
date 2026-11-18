import { createHmac, timingSafeEqual } from "crypto";
import nodemailer, { Transporter } from "nodemailer";
import { ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { smtpCredentials } from "./channels.service";
import { env } from "../../config/env";
import { escapeHtml } from "../../utils/html";

/**
 * Admin Console 2: outbound email over the SMTP server an admin connected in the dashboard.
 *
 * Bodies are written by admins as plain text with a tiny, safe formatting subset -- paragraphs,
 * line breaks, **bold**, and [links](https://...) -- and rendered here. Everything else is
 * HTML-escaped, so nothing an admin types can inject markup or script into the email.
 */

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  /** Files to attach (e.g. an invoice PDF). */
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

let transport: { version: string; transporter: Transporter } | null = null;
let testTransport: Transporter | null = null;

/** Tests only: route every email into a capturing transport (e.g. nodemailer jsonTransport). */
export function setEmailTransportForTesting(t: Transporter | null): void {
  testTransport = t;
  transport = null;
}

async function getTransport(): Promise<{ transporter: Transporter; from: string; replyTo: string | null }> {
  const creds = await smtpCredentials();
  if (!creds) {
    throw new ValidationError("Email is not connected. Connect an SMTP server under Messaging -> Email first.");
  }
  const { config, password, version } = creds;
  const from = `"${config.from_name.replace(/"/g, "'")}" <${config.from_email}>`;
  if (testTransport) {
    return { transporter: testTransport, from, replyTo: config.reply_to };
  }
  if (!transport || transport.version !== version) {
    transport = {
      version,
      transporter: nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.username ? { user: config.username, pass: password ?? "" } : undefined,
        connectionTimeout: 15_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      }),
    };
  }
  return { transporter: transport.transporter, from, replyTo: config.reply_to };
}

export async function sendEmail(message: OutgoingEmail): Promise<string | null> {
  const { transporter, from, replyTo } = await getTransport();
  const info = await transporter.sendMail({
    from,
    to: message.to,
    replyTo: replyTo ?? undefined,
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: message.headers,
    attachments: message.attachments,
  });
  return (info as { messageId?: string }).messageId ?? null;
}

/** Ask the SMTP server to accept our credentials, without sending anything. */
export async function verifySmtp(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { transporter } = await getTransport();
    await transporter.verify();
    return { ok: true, detail: "The SMTP server accepted the connection and credentials." };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 300) : "SMTP verification failed." };
  }
}

// ---------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------

function inline(text: string): string {
  // Escape first, then re-introduce the two allowed constructs on the escaped text.
  let out = escapeHtml(text);
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\[([^\]]{1,200})\]\((https:\/\/[^\s)]{1,500})\)/g, (_m, label: string, url: string) => {
    return `<a href="${url}" style="color:#C28014;text-decoration:underline">${label}</a>`;
  });
  return out.replace(/\n/g, "<br>");
}

export function renderEmailBody(body: string): { html: string; text: string } {
  const paragraphs = body.replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const html = paragraphs.map((p) => `<p style="margin:0 0 16px;line-height:1.6">${inline(p)}</p>`).join("");
  const text = body
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, "$1 ($2)");
  return { html, text };
}

export function wrapEmail(params: { subject: string; bodyHtml: string; bodyText: string; ctaUrl?: string | null; unsubscribeUrl?: string | null }): {
  html: string;
  text: string;
} {
  const cta =
    params.ctaUrl && params.ctaUrl.startsWith("https://")
      ? `<p style="margin:24px 0"><a href="${escapeHtml(params.ctaUrl)}" style="background:#C28014;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Open</a></p>`
      : "";
  const footer = params.unsubscribeUrl
    ? `<p style="margin:24px 0 0;font-size:12px;color:#6b7280">You are receiving this because you have a ${escapeHtml(env.BRAND_NAME)} account. <a href="${escapeHtml(params.unsubscribeUrl)}" style="color:#6b7280">Unsubscribe from announcements</a>.</p>`
    : "";
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:32px">
<tr><td style="font-size:18px;font-weight:700;padding-bottom:24px">Prod<span style="color:#C28014">.</span>Bnb</td></tr>
<tr><td style="font-size:15px">${params.bodyHtml}${cta}${footer}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    params.bodyText,
    params.ctaUrl ? `\nOpen: ${params.ctaUrl}` : "",
    params.unsubscribeUrl ? `\n\nUnsubscribe from announcements: ${params.unsubscribeUrl}` : "",
  ].join("");
  return { html, text };
}

// ---------------------------------------------------------------------------------------------------
// One-click unsubscribe (RFC 8058) -- HMAC-signed, no login needed, nothing to guess.
// ---------------------------------------------------------------------------------------------------

let unsubscribeKey: string | null = null;

async function signingKey(): Promise<string> {
  if (unsubscribeKey) {
    return unsubscribeKey;
  }
  const { data, error } = await adminClient.rpc("system_secret", { _name: "prodbnb_unsubscribe_key" });
  if (error || typeof data !== "string" || data.length < 32) {
    throw error ?? new Error("Unsubscribe signing key is missing.");
  }
  unsubscribeKey = data;
  return data;
}

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function unsubscribeToken(email: string): Promise<string> {
  const payload = b64url(email.toLowerCase());
  const mac = b64url(createHmac("sha256", await signingKey()).update(payload).digest());
  return `${payload}.${mac}`;
}

export async function verifyUnsubscribeToken(token: string): Promise<string | null> {
  const [payload, mac] = token.split(".");
  if (!payload || !mac) {
    return null;
  }
  const expected = b64url(createHmac("sha256", await signingKey()).update(payload).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }
  const email = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return /^[^@\s]+@[^@\s]+$/.test(email) ? email : null;
}

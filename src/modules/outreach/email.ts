import { createHmac, timingSafeEqual } from "crypto";
import nodemailer, { Transporter } from "nodemailer";
import { ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { smtpCredentials } from "./channels.service";
import { env } from "../../config/env";
import { escapeHtml } from "../../utils/html";
import { Block, BRAND_RED, renderLayout } from "../email/layout";

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
  /** "marketing" sends from the news address when one is set (Messaging -> Email), so news
   * and offers never share a sender -- and a reputation -- with booking emails. */
  stream?: "transactional" | "marketing";
}

let transport: { version: string; transporter: Transporter } | null = null;
let testTransport: Transporter | null = null;

/** Tests only: route every email into a capturing transport (e.g. nodemailer jsonTransport). */
export function setEmailTransportForTesting(t: Transporter | null): void {
  testTransport = t;
  transport = null;
}

async function getTransport(): Promise<{ transporter: Transporter; from: string; marketingFrom: string; replyTo: string | null }> {
  const creds = await smtpCredentials();
  if (!creds) {
    throw new ValidationError("Email is not connected. Connect an SMTP server under Messaging -> Email first.");
  }
  const { config, password, version } = creds;
  const name = config.from_name.replace(/"/g, "'");
  const from = `"${name}" <${config.from_email}>`;
  const marketingFrom = config.marketing_from_email ? `"${name}" <${config.marketing_from_email}>` : from;
  if (testTransport) {
    return { transporter: testTransport, from, marketingFrom, replyTo: config.reply_to };
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
  return { transporter: transport.transporter, from, marketingFrom, replyTo: config.reply_to };
}

export async function sendEmail(message: OutgoingEmail): Promise<string | null> {
  const { transporter, from, marketingFrom, replyTo } = await getTransport();
  const info = await transporter.sendMail({
    from: message.stream === "marketing" ? marketingFrom : from,
    to: message.to,
    replyTo: replyTo ?? env.SUPPORT_EMAIL,
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
    return `<a href="${url}" style="color:${BRAND_RED};text-decoration:underline">${label}</a>`;
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

/** An admin-written message (announcement, direct message, test) in the branded email shell. */
export function wrapEmail(params: { subject: string; bodyHtml: string; bodyText: string; ctaUrl?: string | null; ctaLabel?: string; unsubscribeUrl?: string | null }): {
  html: string;
  text: string;
} {
  const blocks: Block[] = [{ kind: "html", html: params.bodyHtml, text: params.bodyText }];
  if (params.ctaUrl && params.ctaUrl.startsWith("https://")) {
    blocks.push({ kind: "button", label: params.ctaLabel ?? "Open", url: params.ctaUrl });
  }
  const email = renderLayout({
    subject: params.subject,
    preheader: params.bodyText.replace(/\s+/g, " ").slice(0, 120),
    blocks,
    footerNote: params.unsubscribeUrl ? `You're getting this because you have a ${env.BRAND_NAME} account.` : undefined,
    unsubscribeUrl: params.unsubscribeUrl,
  });
  return { html: email.html, text: email.text };
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

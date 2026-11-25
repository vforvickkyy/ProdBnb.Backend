import { env } from "../../config/env";
import { escapeHtml } from "../../utils/html";

/**
 * The branded shell every transactional email uses: wordmark, one card, footer. Table layout and
 * inline styles only (what email clients render), a hidden preheader for the inbox preview, and a
 * plain-text twin built from the same blocks so both always say the same thing.
 */

export const BRAND_RED = "#7B0113";

export type Block =
  | { kind: "heading"; text: string }
  | { kind: "text"; text: string; muted?: boolean }
  | { kind: "details"; rows: [string, string][] }
  | { kind: "button"; label: string; url: string; secondary?: boolean }
  | { kind: "buttons"; items: { label: string; url: string; secondary?: boolean }[] }
  | { kind: "note"; text: string }
  | { kind: "divider" }
  /** Already-safe HTML (e.g. an admin's message rendered by renderEmailBody) with its text version. */
  | { kind: "html"; html: string; text: string };

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function safeUrl(url: string): string | null {
  return /^https:\/\//.test(url) || /^http:\/\/localhost/.test(url) ? url : null;
}

function buttonHtml(label: string, url: string, secondary = false): string {
  const href = safeUrl(url);
  if (!href) return "";
  const style = secondary
    ? `background:#ffffff;color:${BRAND_RED};border:1px solid #e4e4e7`
    : `background:${BRAND_RED};color:#ffffff;border:1px solid ${BRAND_RED}`;
  return `<a href="${escapeHtml(href)}" style="${style};display:inline-block;padding:12px 22px;border-radius:999px;font-weight:600;font-size:15px;text-decoration:none;margin:0 8px 8px 0">${escapeHtml(label)}</a>`;
}

function blockHtml(block: Block): string {
  switch (block.kind) {
    case "heading":
      return `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#18181b">${escapeHtml(block.text)}</h1>`;
    case "text":
      return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${block.muted ? "#71717a" : "#27272a"}">${escapeHtml(block.text).replace(/\n/g, "<br>")}</p>`;
    case "note":
      return `<p style="margin:0 0 16px;padding:12px 14px;background:#fafafa;border-radius:10px;font-size:14px;line-height:1.5;color:#3f3f46">${escapeHtml(block.text).replace(/\n/g, "<br>")}</p>`;
    case "details":
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border:1px solid #f4f4f5;border-radius:12px">${block.rows
        .map(
          ([k, v], i) =>
            `<tr><td style="padding:10px 14px;font-size:13px;color:#71717a;width:38%;vertical-align:top;${i ? "border-top:1px solid #f4f4f5;" : ""}">${escapeHtml(k)}</td><td style="padding:10px 14px;font-size:14px;color:#18181b;font-weight:500;${i ? "border-top:1px solid #f4f4f5;" : ""}">${escapeHtml(v)}</td></tr>`
        )
        .join("")}</table>`;
    case "button":
      return `<p style="margin:8px 0 16px">${buttonHtml(block.label, block.url, block.secondary)}</p>`;
    case "buttons":
      return `<p style="margin:8px 0 16px">${block.items.map((b) => buttonHtml(b.label, b.url, b.secondary)).join("")}</p>`;
    case "divider":
      return `<hr style="border:none;border-top:1px solid #f4f4f5;margin:20px 0">`;
    case "html":
      return `<div style="font-size:15px;line-height:1.6;color:#27272a">${block.html}</div>`;
  }
}

function blockText(block: Block): string {
  switch (block.kind) {
    case "heading":
      return block.text.toUpperCase();
    case "text":
    case "note":
      return block.text;
    case "details":
      return block.rows.map(([k, v]) => `${k}: ${v}`).join("\n");
    case "button":
      return `${block.label}: ${block.url}`;
    case "buttons":
      return block.items.map((b) => `${b.label}: ${b.url}`).join("\n");
    case "divider":
      return "---";
    case "html":
      return block.text;
  }
}

export function renderLayout(params: {
  subject: string;
  preheader: string;
  blocks: Block[];
  footerNote?: string;
  /** Marketing emails: the one-click unsubscribe link shown in the footer. */
  unsubscribeUrl?: string | null;
}): RenderedEmail {
  const brand = escapeHtml(env.BRAND_NAME);
  const site = env.WEBSITE_URL.replace(/\/$/, "");
  const note =
    params.footerNote ??
    `You're getting this email because of activity on your ${env.BRAND_NAME} account. Account and booking emails can't be switched off.`;
  const help = `Questions? Reply to this email or write to ${env.SUPPORT_EMAIL}.`;
  const company = `${env.BRAND_NAME} is run by ${env.COMPANY_LEGAL_NAME}.`;
  const unsubscribe = params.unsubscribeUrl
    ? `<br><a href="${escapeHtml(params.unsubscribeUrl)}" style="color:#71717a">Unsubscribe from news and offers</a>`
    : "";
  const footerHtml = `${escapeHtml(note)}<br>${escapeHtml(help)}<br>${escapeHtml(company)}${unsubscribe}`;
  const footer = [note, help, company, params.unsubscribeUrl ? `Unsubscribe from news and offers: ${params.unsubscribeUrl}` : ""].filter(Boolean).join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(params.subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(params.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 8px 16px;font-size:24px;font-weight:800;letter-spacing:-0.5px;color:${BRAND_RED}">${brand.toLowerCase()}</td></tr>
<tr><td style="background:#ffffff;border-radius:16px;padding:28px 24px">${params.blocks.map(blockHtml).join("")}</td></tr>
<tr><td style="padding:16px 8px 0;font-size:12px;line-height:1.5;color:#a1a1aa">${footerHtml}<br><a href="${escapeHtml(site)}" style="color:#a1a1aa">${escapeHtml(site.replace(/^https?:\/\//, ""))}</a></td></tr>
</table></td></tr></table></body></html>`;
  const text = [...params.blocks.map(blockText), "", footer, site].join("\n\n");
  return { subject: params.subject, html, text };
}

export function siteUrl(path: string): string {
  return `${env.WEBSITE_URL.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

export function money(minor: number | null | undefined, currency = "INR"): string {
  if (minor === null || minor === undefined) return "—";
  const value = minor / 100;
  const symbol = currency === "INR" ? "₹" : `${currency} `;
  return `${symbol}${value.toLocaleString("en-IN", { minimumFractionDigits: value % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** "Fri 12 Dec 2026, 10:00 am – 2:00 pm" in the place's time zone. */
export function whenLabel(startIso: string, endIso: string, timeZone = "Asia/Kolkata"): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const day = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone }).format(start);
  const time = (d: Date) => new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).format(d).toLowerCase();
  const sameDay =
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(start) === new Intl.DateTimeFormat("en-CA", { timeZone }).format(end);
  if (sameDay) return `${day}, ${time(start)} – ${time(end)}`;
  const endDay = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone }).format(end);
  return `${day}, ${time(start)} – ${endDay}, ${time(end)}`;
}

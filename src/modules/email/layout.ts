import { env } from "../../config/env";
import { escapeHtml } from "../../utils/html";

/**
 * The branded shell every transactional email uses: wordmark, one card, footer. Table layout and
 * inline styles only (what email clients render), a hidden preheader for the inbox preview, and a
 * plain-text twin built from the same blocks so both always say the same thing.
 */

export const BRAND_RED = "#7B0113";
/** The brand red on dark backgrounds (the deep red is unreadable on near-black). */
const BRAND_RED_ON_DARK = "#FF6B6B";

/** A listing as an email shows it: photo, name, where, a few facts, price, link. */
export interface EmailListing {
  title: string;
  place: string;
  image_url: string | null;
  facts: string[];
  price: string | null;
  url: string;
}

export type Block =
  | { kind: "heading"; text: string }
  | { kind: "text"; text: string; muted?: boolean }
  | { kind: "details"; rows: [string, string][] }
  | { kind: "button"; label: string; url: string; secondary?: boolean }
  | { kind: "buttons"; items: { label: string; url: string; secondary?: boolean }[] }
  | { kind: "note"; text: string }
  | { kind: "divider" }
  /** Already-safe HTML (e.g. an admin's message rendered by renderEmailBody) with its text version. */
  | { kind: "html"; html: string; text: string }
  /** A small label above a heading ("NEW IN MUMBAI"). */
  | { kind: "eyebrow"; text: string }
  /** A wide picture, optionally linked. */
  | { kind: "image"; url: string; alt: string; href?: string }
  /** One listing, big: photo, facts, price and a button. */
  | { kind: "listing"; listing: EmailListing; button: string }
  /** Several listings as a two-column grid (one column on phones). */
  | { kind: "listings"; listings: EmailListing[] }
  /** A one-time code, big and easy to copy. */
  | { kind: "code"; code: string; label: string }
  /** A coupon code in a dashed box. */
  | { kind: "coupon"; code: string; title: string; detail?: string };

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function safeUrl(url: string): string | null {
  return /^https:\/\//.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url) ? url : null;
}

/*
 * Light and dark. Every coloured element carries a class as well as its inline (light) style; the
 * dark rules below override them where the mail app supports it (Apple Mail, iOS Mail, Outlook
 * apps, Gmail on iOS partly). Apps that ignore them invert colours themselves, which this design
 * survives: no text baked into images, no transparent logos, real contrast both ways.
 * `.pb-force-dark` applies the same rules for the admin's dark preview.
 */
const DARK_RULES = `
.pb-bg{background:#0b0b0c!important}
.pb-card{background:#18181b!important}
.pb-h{color:#fafafa!important}
.pb-text{color:#e4e4e7!important}
.pb-muted{color:#a1a1aa!important}
.pb-note{background:#27272a!important;color:#e4e4e7!important}
.pb-line{border-color:#27272a!important}
.pb-brand{color:${BRAND_RED_ON_DARK}!important}
.pb-eyebrow{color:${BRAND_RED_ON_DARK}!important}
.pb-btn2{background:#18181b!important;color:#fafafa!important;border-color:#3f3f46!important}
.pb-coupon{background:#27272a!important;border-color:${BRAND_RED_ON_DARK}!important}
.pb-code{color:${BRAND_RED_ON_DARK}!important}
.pb-foot,.pb-foot a{color:#71717a!important}
.pb-tile{background:#202023!important;border-color:#27272a!important}`;

function darkCss(): string {
  const forced = DARK_RULES.trim()
    .split("\n")
    .map((rule) => rule.replace(/^([^{]+)\{/, (_m, sel: string) => `${sel.split(",").map((x) => `.pb-force-dark ${x.trim()}`).join(",")}{`))
    .join("\n");
  const ogsc = DARK_RULES.trim()
    .split("\n")
    .map((rule) => rule.replace(/^([^{]+)\{/, (_m, sel: string) => `${sel.split(",").map((x) => `[data-ogsc] ${x.trim()}`).join(",")}{`))
    .join("\n");
  return `:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme: dark){${DARK_RULES}}
${ogsc}
${forced}
@media (max-width:520px){.pb-col{display:block!important;width:100%!important;padding:0 0 12px!important}.pb-pad{padding:22px 18px!important}}`;
}

function buttonHtml(label: string, url: string, secondary = false): string {
  const href = safeUrl(url);
  if (!href) return "";
  const style = secondary
    ? `background:#ffffff;color:${BRAND_RED};border:1px solid #e4e4e7`
    : `background:${BRAND_RED};color:#ffffff;border:1px solid ${BRAND_RED}`;
  return `<a href="${escapeHtml(href)}" class="${secondary ? "pb-btn2" : ""}" style="${style};display:inline-block;padding:12px 22px;border-radius:999px;font-weight:600;font-size:15px;text-decoration:none;margin:0 8px 8px 0">${escapeHtml(label)}</a>`;
}

function listingCardHtml(l: EmailListing, compact: boolean): string {
  const href = safeUrl(l.url);
  const img = l.image_url && safeUrl(l.image_url)
    ? `<a href="${escapeHtml(href ?? "#")}"><img src="${escapeHtml(l.image_url)}" alt="${escapeHtml(l.title)}" width="${compact ? 250 : 512}" style="display:block;width:100%;height:auto;max-height:${compact ? 170 : 320}px;object-fit:cover;border-radius:${compact ? "12px 12px 0 0" : "14px"};border:0"></a>`
    : "";
  const facts = l.facts.length ? `<div class="pb-muted" style="margin-top:6px;font-size:13px;color:#71717a">${l.facts.map(escapeHtml).join(" · ")}</div>` : "";
  const price = l.price ? `<div class="pb-h" style="margin-top:8px;font-size:${compact ? 14 : 16}px;font-weight:700;color:#18181b">${escapeHtml(l.price)}</div>` : "";
  const title = `<a href="${escapeHtml(href ?? "#")}" class="pb-h" style="color:#18181b;text-decoration:none;font-size:${compact ? 15 : 20}px;font-weight:700;line-height:1.3">${escapeHtml(l.title)}</a>`;
  const place = `<div class="pb-muted" style="margin-top:2px;font-size:13px;color:#71717a">${escapeHtml(l.place)}</div>`;
  if (compact) {
    return `<div class="pb-tile" style="border:1px solid #f0f0f1;border-radius:12px;background:#ffffff">${img}<div style="padding:10px 12px 12px">${title}${place}${price}</div></div>`;
  }
  return `${img}<div style="padding:14px 2px 4px">${title}${place}${facts}${price}</div>`;
}

function blockHtml(block: Block): string {
  switch (block.kind) {
    case "heading":
      return `<h1 class="pb-h" style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#18181b">${escapeHtml(block.text)}</h1>`;
    case "eyebrow":
      return `<div class="pb-eyebrow" style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${BRAND_RED}">${escapeHtml(block.text)}</div>`;
    case "text":
      return `<p class="${block.muted ? "pb-muted" : "pb-text"}" style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${block.muted ? "#71717a" : "#27272a"}">${escapeHtml(block.text).replace(/\n/g, "<br>")}</p>`;
    case "note":
      return `<p class="pb-note" style="margin:0 0 16px;padding:12px 14px;background:#fafafa;border-radius:10px;font-size:14px;line-height:1.5;color:#3f3f46">${escapeHtml(block.text).replace(/\n/g, "<br>")}</p>`;
    case "details":
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="pb-line" style="margin:0 0 20px;border:1px solid #f4f4f5;border-radius:12px">${block.rows
        .map(
          ([k, v], i) =>
            `<tr><td class="pb-muted pb-line" style="padding:10px 14px;font-size:13px;color:#71717a;width:38%;vertical-align:top;${i ? "border-top:1px solid #f4f4f5;" : ""}">${escapeHtml(k)}</td><td class="pb-h pb-line" style="padding:10px 14px;font-size:14px;color:#18181b;font-weight:500;${i ? "border-top:1px solid #f4f4f5;" : ""}">${escapeHtml(v)}</td></tr>`
        )
        .join("")}</table>`;
    case "button":
      return `<p style="margin:8px 0 16px">${buttonHtml(block.label, block.url, block.secondary)}</p>`;
    case "buttons":
      return `<p style="margin:8px 0 16px">${block.items.map((b) => buttonHtml(b.label, b.url, b.secondary)).join("")}</p>`;
    case "divider":
      return `<hr class="pb-line" style="border:none;border-top:1px solid #f4f4f5;margin:20px 0">`;
    case "html":
      return `<div class="pb-text" style="font-size:15px;line-height:1.6;color:#27272a">${block.html}</div>`;
    case "image": {
      const src = safeUrl(block.url);
      if (!src) return "";
      const img = `<img src="${escapeHtml(src)}" alt="${escapeHtml(block.alt)}" width="512" style="display:block;width:100%;height:auto;border-radius:14px;border:0">`;
      const href = block.href ? safeUrl(block.href) : null;
      return `<div style="margin:0 0 18px">${href ? `<a href="${escapeHtml(href)}">${img}</a>` : img}</div>`;
    }
    case "listing":
      return `<div style="margin:0 0 8px">${listingCardHtml(block.listing, false)}</div><p style="margin:12px 0 16px">${buttonHtml(block.button, block.listing.url)}</p>`;
    case "listings": {
      const rows: string[] = [];
      for (let i = 0; i < block.listings.length; i += 2) {
        const pair = block.listings.slice(i, i + 2);
        rows.push(
          `<tr>${pair
            .map((l, j) => `<td class="pb-col" width="50%" valign="top" style="width:50%;padding:0 ${j === 0 ? 6 : 0}px 12px ${j === 1 ? 6 : 0}px">${listingCardHtml(l, true)}</td>`)
            .join("")}${pair.length === 1 ? `<td class="pb-col" width="50%" style="width:50%"></td>` : ""}</tr>`
        );
      }
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 8px">${rows.join("")}</table>`;
    }
    case "code":
      return `<div class="pb-note" style="margin:4px 0 18px;padding:16px;background:#fafafa;border-radius:12px;text-align:center">
<div class="pb-muted" style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#71717a">${escapeHtml(block.label)}</div>
<div class="pb-h" style="margin-top:6px;font-size:30px;font-weight:800;letter-spacing:6px;color:#18181b;font-family:'SF Mono',Menlo,Consolas,monospace">${escapeHtml(block.code)}</div></div>`;
    case "coupon":
      return `<div class="pb-coupon" style="margin:4px 0 18px;padding:18px;border:2px dashed ${BRAND_RED};border-radius:14px;background:#fff7f7;text-align:center">
<div class="pb-muted" style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#71717a">Your code</div>
<div class="pb-code" style="margin:6px 0;font-size:26px;font-weight:800;letter-spacing:3px;color:${BRAND_RED};font-family:'SF Mono',Menlo,Consolas,monospace">${escapeHtml(block.code)}</div>
<div class="pb-h" style="font-size:15px;font-weight:600;color:#18181b">${escapeHtml(block.title)}</div>${block.detail ? `<div class="pb-muted" style="margin-top:4px;font-size:13px;color:#71717a">${escapeHtml(block.detail)}</div>` : ""}</div>`;
  }
}

function listingText(l: EmailListing): string {
  return [l.title, l.place, l.facts.join(" · "), l.price, l.url].filter(Boolean).join("\n");
}

function blockText(block: Block): string {
  switch (block.kind) {
    case "heading":
      return block.text.toUpperCase();
    case "eyebrow":
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
    case "image":
      return block.href ? `${block.alt}: ${block.href}` : "";
    case "listing":
      return `${listingText(block.listing)}`;
    case "listings":
      return block.listings.map(listingText).join("\n\n");
    case "code":
      return `${block.label}: ${block.code}`;
    case "coupon":
      return `Your code: ${block.code}\n${block.title}${block.detail ? `\n${block.detail}` : ""}`;
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
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(params.subject)}</title><style>${darkCss()}</style></head>
<body class="pb-bg" style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(params.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="pb-bg" style="background:#f4f4f5;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td class="pb-brand" style="padding:0 8px 16px;font-size:24px;font-weight:800;letter-spacing:-0.5px;color:${BRAND_RED}">${brand.toLowerCase()}</td></tr>
<tr><td class="pb-card pb-pad" style="background:#ffffff;border-radius:16px;padding:28px 24px">${params.blocks.map(blockHtml).join("")}</td></tr>
<tr><td class="pb-foot" style="padding:16px 8px 0;font-size:12px;line-height:1.5;color:#a1a1aa">${footerHtml}<br><a href="${escapeHtml(site)}" style="color:#a1a1aa">${escapeHtml(site.replace(/^https?:\/\//, ""))}</a></td></tr>
</table></td></tr></table></body></html>`;
  const text = [...params.blocks.map(blockText).filter(Boolean), "", footer, site].join("\n\n");
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

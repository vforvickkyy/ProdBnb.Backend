import { env } from "../../config/env";

/**
 * Phone numbers, SMS wording and DLT rules -- pure functions, no database.
 *
 * DLT (India) matches every text against a registered template word for word: fixed text must be
 * identical and each {#var#} may hold at most 30 characters. So:
 *  - {brand} and {site} are fixed text: the DLT form spells them out;
 *  - every other {placeholder} is a {#var#} and its value is cut to 30 characters;
 *  - values are kept to plain characters so a text stays in the cheap 160-character encoding.
 */

export const DLT_VAR_MAX = 30;
const FIXED = new Set(["brand", "site"]);

/** "+91 98765-43210", "098765 43210", "919876543210" -> "+919876543210". Null when not a mobile number. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  let digits = trimmed.replace(/[^0-9]/g, "");
  if (!digits) return null;
  if (trimmed.startsWith("+")) {
    if (digits.length < 8 || digits.length > 15) return null;
    if (digits.startsWith("91")) return isIndianMobile(digits.slice(2)) ? `+${digits}` : null;
    return `+${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  return isIndianMobile(digits) ? `+91${digits}` : null;
}

function isIndianMobile(tenDigits: string): boolean {
  return /^[6-9][0-9]{9}$/.test(tenDigits);
}

export function isIndianNumber(e164: string): boolean {
  return e164.startsWith("+91") && isIndianMobile(e164.slice(3));
}

/** "+919876543210" -> "+91 98•••••210", for logs shown to the team. */
export function maskPhone(e164: string): string {
  if (e164.length < 8) return e164;
  const cc = e164.startsWith("+91") ? "+91 " : e164.slice(0, 3) + " ";
  const rest = e164.startsWith("+91") ? e164.slice(3) : e164.slice(3);
  return `${cc}${rest.slice(0, 2)}${"•".repeat(Math.max(rest.length - 5, 1))}${rest.slice(-3)}`;
}

// GSM 03.38 basic set + extension table: these keep a text at 160 characters per part.
const GSM = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€";

/** How many SMS parts a text costs, and in which encoding. */
export function smsSegments(text: string): { encoding: "GSM-7" | "Unicode"; characters: number; segments: number } {
  const chars = Array.from(text);
  const gsm = chars.every((c) => GSM.includes(c) || GSM_EXT.includes(c));
  if (gsm) {
    const units = chars.reduce((n, c) => n + (GSM_EXT.includes(c) ? 2 : 1), 0);
    return { encoding: "GSM-7", characters: units, segments: units <= 160 ? 1 : Math.ceil(units / 153) };
  }
  const units = text.length; // UTF-16 code units
  return { encoding: "Unicode", characters: units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
}

/** Plain-character, single-line, at most 30 characters (cut at a word where possible). */
export function dltValue(value: string | number | null | undefined): string {
  let s = String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/₹/g, "Rs.")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim();
  s = Array.from(s).filter((c) => GSM.includes(c) || GSM_EXT.includes(c)).join("");
  if (s.length <= DLT_VAR_MAX) return s;
  const cut = s.slice(0, DLT_VAR_MAX);
  const space = cut.lastIndexOf(" ");
  return (space >= 18 ? cut.slice(0, space) : cut).replace(/[\s,.-]+$/, "");
}

export function brandText(): string {
  return env.BRAND_NAME;
}

/** "https://www.heken.co/" -> "heken.co". */
export function siteText(): string {
  try {
    return new URL(env.WEBSITE_URL).host.replace(/^www\./, "");
  } catch {
    return env.WEBSITE_URL.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

/** The placeholders a template uses, in order, without repeats. */
export function placeholders(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\{([a-z_]+)\}/g)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/** The text to register on the DLT portal: {brand}/{site} spelled out, the rest as {#var#}. */
export function dltForm(body: string): string {
  return body.replace(/\{([a-z_]+)\}/g, (_m, name: string) => {
    if (name === "brand") return brandText();
    if (name === "site") return siteText();
    return "{#var#}";
  });
}

/** Fills a template. Missing values become "-" so the text still matches its DLT template. */
export function renderSms(body: string, vars: Record<string, string | number | null | undefined>): string {
  return body.replace(/\{([a-z_]+)\}/g, (_m, name: string) => {
    if (name === "brand") return brandText();
    if (name === "site") return siteText();
    const v = dltValue(vars[name]);
    return v || "-";
  });
}

export function isFixedPlaceholder(name: string): boolean {
  return FIXED.has(name);
}

/** "Fri 27 Nov, 8:30 am-6 pm" (or "27 Nov 8 am-28 Nov 6 pm"), kept under 30 characters. */
export function smsWhen(startIso: string, endIso: string, timeZone = "Asia/Kolkata"): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const time = (d: Date) =>
    new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone })
      .format(d)
      .toLowerCase()
      .replace(":00", "")
      .replace(/\s+/g, " ");
  const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(d);
  const dayMonth = (d: Date) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone }).format(d);
  if (ymd(start) === ymd(end)) {
    const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone }).format(start);
    return `${weekday} ${dayMonth(start)}, ${time(start)}-${time(end)}`;
  }
  return `${dayMonth(start)} ${time(start)}-${dayMonth(end)} ${time(end)}`;
}

/** "Rs.12,500" -- the rupee sign would switch the whole text to the 70-character encoding. */
export function smsMoney(minor: number | null | undefined, currency = "INR"): string {
  if (minor === null || minor === undefined) return "-";
  const value = minor / 100;
  const formatted = value.toLocaleString("en-IN", { minimumFractionDigits: value % 1 ? 2 : 0, maximumFractionDigits: 2 });
  return currency === "INR" ? `Rs.${formatted}` : `${currency} ${formatted}`;
}

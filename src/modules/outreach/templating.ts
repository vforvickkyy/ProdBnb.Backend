import { ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { getSiteSettings } from "../site/integrations.service";

/**
 * Variables in notification text: `{first_name}` is replaced per person, `{listing_title}` with the
 * listing the campaign is about, and so on. `{first_name|there}` falls back to "there" when the
 * person hasn't given a first name. Unknown variables are refused before anything is saved, so a
 * typo never reaches someone's phone as "{frist_name}".
 */

export type VariableScope = "person" | "listing" | "offer";

export interface VariableInfo {
  key: string;
  label: string;
  example: string;
  scope: VariableScope;
}

export const VARIABLES: VariableInfo[] = [
  { key: "first_name", label: "First name", example: "Riya", scope: "person" },
  { key: "last_name", label: "Last name", example: "Menon", scope: "person" },
  { key: "name", label: "Full name", example: "Riya Menon", scope: "person" },
  { key: "city", label: "Their city", example: "Mumbai", scope: "person" },
  { key: "city_suffix", label: "“ in <their city>”, or nothing", example: " in Mumbai", scope: "person" },
  { key: "profession", label: "What they do", example: "Director", scope: "person" },
  { key: "listing_title", label: "Listing name", example: "Sunlit heritage bungalow", scope: "listing" },
  { key: "listing_city", label: "Listing city", example: "Mumbai", scope: "listing" },
  { key: "listing_price", label: "Listing price", example: "₹2,500/hour", scope: "listing" },
  { key: "listing_url", label: "Listing link", example: "https://…/locations/…", scope: "listing" },
  { key: "offer_code", label: "Offer code", example: "MONSOON20", scope: "offer" },
  { key: "offer_title", label: "Offer title", example: "Monsoon sale on all studios", scope: "offer" },
  { key: "offer_discount", label: "Offer discount", example: "20% off", scope: "offer" },
  { key: "offer_ends", label: "“ until <end date>”, or nothing", example: " until 31 Dec", scope: "offer" },
];
const BY_KEY = new Map(VARIABLES.map((v) => [v.key, v]));

const TOKEN = /\{([a-z_]+)(?:\|([^{}]*))?\}/g;

export const PROFESSION_LABEL: Record<string, string> = {
  producer: "Producer",
  director: "Director",
  cinematographer: "Cinematographer",
  photographer: "Photographer",
  production_house: "Production house",
  ad_agency: "Ad agency",
  content_creator: "Content creator",
  art_director: "Art director",
  location_manager: "Location manager",
  student: "Student",
  location_owner: "Location owner",
  other: "Other",
};

export type Vars = Record<string, string | null | undefined>;

/** Replaces every `{key}` / `{key|fallback}`. A missing value uses the fallback, else nothing. */
export function render(text: string, vars: Vars): string;
export function render(text: string | null, vars: Vars): string | null;
export function render(text: string | null, vars: Vars): string | null {
  if (text == null) return null;
  return text
    .replace(TOKEN, (whole, key: string, fallback: string | undefined) => {
      if (!BY_KEY.has(key)) return whole;
      const value = vars[key];
      return value != null && value !== "" ? value : (fallback ?? "");
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ([,.!?])/g, "$1");
}

export function variablesIn(...texts: (string | null | undefined)[]): string[] {
  const keys = new Set<string>();
  for (const t of texts) for (const m of (t ?? "").matchAll(TOKEN)) keys.add(m[1]!);
  return [...keys];
}

/** Refuses unknown variables, and listing/offer variables without a listing/offer picked. */
export function checkVariables(texts: (string | null | undefined)[], context: { listing: boolean; offer: boolean }): void {
  const used = variablesIn(...texts);
  const unknown = used.filter((k) => !BY_KEY.has(k));
  if (unknown.length) {
    throw new ValidationError(`Unknown variable${unknown.length > 1 ? "s" : ""}: ${unknown.map((k) => `{${k}}`).join(", ")}. Pick one from the list.`);
  }
  if (!context.listing && used.some((k) => BY_KEY.get(k)!.scope === "listing")) {
    throw new ValidationError("This text uses listing details ({listing_…}). Pick the listing it's about.");
  }
  if (!context.offer && used.some((k) => BY_KEY.get(k)!.scope === "offer")) {
    throw new ValidationError("This text uses offer details ({offer_…}). Pick the offer it's about.");
  }
}

// -- Values ------------------------------------------------------------------------------------------

const money = (minor: number) => `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: minor % 100 ? 2 : 0 })}`;
const UNIT: Record<string, string> = { hourly: "/hour", half_day: "/half day", day: "/day", multi_day: "/day" };

function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

/** The listing's page on the website when a domain is set, otherwise the app's deep link. */
export async function listingUrl(listing: { id: string; title: string; city: string | null }): Promise<string> {
  const site = await getSiteSettings().catch(() => null);
  if (!site?.primary_domain) return `prodbnb://location/${listing.id}`;
  const words = slugify([listing.title, listing.city].filter(Boolean).join(" "));
  return `https://${site.primary_domain}/locations/${words ? `${words}-${listing.id}` : listing.id}`;
}

export interface CampaignContext {
  vars: Vars;
  listing: { id: string; title: string; city: string | null; url: string } | null;
  offer: { id: string; code: string; title: string } | null;
}

export async function loadContext(ids: { location_id?: string | null; coupon_id?: string | null }): Promise<CampaignContext> {
  const vars: Vars = {};
  let listing: CampaignContext["listing"] = null;
  let offer: CampaignContext["offer"] = null;
  if (ids.location_id) {
    const { data } = await adminClient
      .from("locations")
      .select("id, title, city, location_pricing(booking_type, amount_minor_units, is_active)")
      .eq("id", ids.location_id)
      .maybeSingle();
    if (!data) throw new ValidationError("That listing doesn't exist any more.");
    const l = data as { id: string; title: string; city: string | null; location_pricing: { booking_type: string; amount_minor_units: number; is_active: boolean }[] | null };
    const prices = (l.location_pricing ?? []).filter((p) => p.is_active !== false);
    const pick = prices.find((p) => p.booking_type === "hourly") ?? prices.sort((a, b) => a.amount_minor_units - b.amount_minor_units)[0];
    const url = await listingUrl(l);
    listing = { id: l.id, title: l.title, city: l.city, url };
    Object.assign(vars, {
      listing_title: l.title,
      listing_city: l.city,
      listing_price: pick ? `${money(pick.amount_minor_units)}${UNIT[pick.booking_type] ?? ""}` : null,
      listing_url: url,
    });
  }
  if (ids.coupon_id) {
    const { data } = await adminClient
      .from("coupons")
      .select("id, code, title, discount_type, percent_off, amount_off_minor_units, max_discount_minor_units, ends_at")
      .eq("id", ids.coupon_id)
      .maybeSingle();
    if (!data) throw new ValidationError("That offer doesn't exist any more.");
    const c = data as { id: string; code: string; title: string; discount_type: string; percent_off: number | null; amount_off_minor_units: number | null; max_discount_minor_units: number | null; ends_at: string | null };
    offer = { id: c.id, code: c.code, title: c.title };
    Object.assign(vars, {
      offer_code: c.code,
      offer_title: c.title,
      offer_discount: c.discount_type === "percent" ? `${c.percent_off}% off` : `${money(c.amount_off_minor_units ?? 0)} off`,
      offer_ends: c.ends_at ? ` until ${new Date(c.ends_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}` : "",
    });
  }
  return { vars, listing, offer };
}

/** Each person's own variables, for a batch of recipients. */
export async function personVars(userIds: string[]): Promise<Map<string, Vars>> {
  const out = new Map<string, Vars>();
  if (userIds.length === 0) return out;
  const [{ data: profiles, error }, { data: prefs, error: e2 }] = await Promise.all([
    adminClient.from("profiles").select("id, first_name, last_name, address_city").in("id", userIds),
    adminClient.from("user_preferences").select("user_id, professions, cities").in("user_id", userIds),
  ]);
  if (error) throw error;
  if (e2) throw e2;
  const prefBy = new Map(((prefs ?? []) as { user_id: string; professions: string[]; cities: string[] }[]).map((p) => [p.user_id, p]));
  for (const p of (profiles ?? []) as { id: string; first_name: string | null; last_name: string | null; address_city: string | null }[]) {
    const pref = prefBy.get(p.id);
    const first = p.first_name?.trim() || null;
    const last = p.last_name?.trim() || null;
    const city = pref?.cities?.[0] ?? p.address_city?.trim() ?? null;
    out.set(p.id, {
      first_name: first,
      last_name: last,
      name: [first, last].filter(Boolean).join(" ") || null,
      city,
      city_suffix: city ? ` in ${city}` : "",
      profession: pref?.professions?.[0] ? (PROFESSION_LABEL[pref.professions[0]] ?? null) : null,
    });
  }
  return out;
}

export interface RenderableContent {
  title: string;
  body: string;
  link_url: string | null;
  email_subject: string | null;
  email_body: string | null;
}

/** The content one person receives. */
export function renderFor(content: RenderableContent, context: CampaignContext, person: Vars | undefined): RenderableContent {
  const vars = { ...context.vars, ...(person ?? {}) };
  return {
    title: render(content.title, vars).slice(0, 160),
    body: render(content.body, vars).slice(0, 1000),
    link_url: content.link_url ?? context.listing?.url ?? null,
    email_subject: render(content.email_subject, vars),
    email_body: render(content.email_body, vars),
  };
}

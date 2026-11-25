import { ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { getLocationCards } from "../locations/locations.service";
import { slugify } from "../outreach/templating";
import { Block, EmailListing, money, renderLayout, siteUrl } from "./layout";
import { env } from "../../config/env";

/**
 * Marketing email designs (news and offers). The admin picks a design and fills a few fields; the
 * listings and offer come from the database when the email is sent, so photos and prices are
 * current. Every design shares the branded shell (light and dark) and the unsubscribe footer.
 *
 *   plain       the message and a button
 *   spotlight   one listing, big: photo, facts, price, "See this place"
 *   collection  2-6 listings as a grid, plus a button to see more
 *   offer       a coupon code box with what it gives and until when
 *   news        a wide picture, a headline, the message and a button (updates, host tips)
 */

export const EMAIL_DESIGNS = ["plain", "spotlight", "collection", "offer", "news"] as const;
export type EmailDesign = (typeof EMAIL_DESIGNS)[number];

const UNIT: Record<string, string> = { hourly: " / hour", daily: " / day", half_day: " / half day" };

export function listingPageUrl(l: { id: string; title: string; city: string | null }): string {
  const words = slugify([l.title, l.city].filter(Boolean).join(" "));
  return siteUrl(`/locations/${words ? `${words}-${l.id}` : l.id}`);
}

/** Published listings in the order given, ready for an email. Unpublished ones are left out. */
export async function loadEmailListings(ids: string[]): Promise<EmailListing[]> {
  if (ids.length === 0) return [];
  const cards = await getLocationCards(adminClient, ids);
  const { data, error } = await adminClient.from("locations").select("id, capacity, area_sqft, set_count, parking_spaces").in("id", ids);
  if (error) throw error;
  const extra = new Map(((data ?? []) as { id: string; capacity: number | null; area_sqft: number | null; set_count: number | null; parking_spaces: number | null }[]).map((r) => [r.id, r]));
  return cards
    .filter((c) => c.status === "published")
    .map((c) => {
      const x = extra.get(c.id);
      const facts: string[] = [];
      if (x?.area_sqft) facts.push(`${x.area_sqft.toLocaleString("en-IN")} sq ft`);
      if (x?.capacity) facts.push(`Up to ${x.capacity} people`);
      if (x?.set_count && x.set_count > 1) facts.push(`${x.set_count} sets`);
      if (x?.parking_spaces) facts.push(`${x.parking_spaces} parking`);
      const price = c.price_on_request
        ? "Price on request"
        : c.starting_price
          ? `From ${money(c.starting_price.amount_minor_units, c.starting_price.currency)}${UNIT[c.starting_price.booking_type] ?? ""}`
          : null;
      return {
        title: c.title,
        place: [c.area, c.city].filter(Boolean).join(", ") || c.city || "",
        image_url: c.cover_url,
        facts,
        price,
        url: listingPageUrl(c),
      };
    });
}

export interface MarketingAssets {
  listings: EmailListing[];
  offer: { code: string; title: string; detail: string | null } | null;
}

/** What a design needs from the database. Refuses designs that are missing their listing/offer. */
export async function loadMarketingAssets(c: {
  email_design: EmailDesign;
  location_id?: string | null;
  email_location_ids?: string[] | null;
  coupon_id?: string | null;
}): Promise<MarketingAssets> {
  const assets: MarketingAssets = { listings: [], offer: null };
  if (c.email_design === "spotlight") {
    if (!c.location_id) throw new ValidationError("A spotlight email needs a listing.");
    assets.listings = await loadEmailListings([c.location_id]);
    if (assets.listings.length === 0) throw new ValidationError("That listing isn't published, so it can't be in an email.");
  }
  if (c.email_design === "collection") {
    const ids = c.email_location_ids ?? [];
    if (ids.length < 2) throw new ValidationError("A collection email needs at least 2 listings.");
    assets.listings = await loadEmailListings(ids);
    if (assets.listings.length < 2) throw new ValidationError("At least 2 of the chosen listings must be published.");
  }
  if (c.email_design === "offer") {
    if (!c.coupon_id) throw new ValidationError("An offer email needs an offer (coupon).");
    const { data } = await adminClient
      .from("coupons")
      .select("code, title, discount_type, percent_off, amount_off_minor_units, max_discount_minor_units, ends_at")
      .eq("id", c.coupon_id)
      .maybeSingle();
    if (!data) throw new ValidationError("That offer doesn't exist any more.");
    const o = data as { code: string; title: string; discount_type: string; percent_off: number | null; amount_off_minor_units: number | null; max_discount_minor_units: number | null; ends_at: string | null };
    const off = o.discount_type === "percent" ? `${o.percent_off}% off` : `${money(o.amount_off_minor_units ?? 0)} off`;
    const cap = o.discount_type === "percent" && o.max_discount_minor_units ? ` (up to ${money(o.max_discount_minor_units)})` : "";
    const until = o.ends_at ? ` · Until ${new Date(o.ends_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}` : "";
    assets.offer = { code: o.code, title: o.title, detail: `${off}${cap}${until}` };
  }
  return assets;
}

export interface MarketingEmailInput {
  design: EmailDesign;
  subject: string;
  /** Big headline at the top; falls back to the subject. */
  heading?: string | null;
  bodyHtml: string;
  bodyText: string;
  imageUrl?: string | null;
  buttonLabel?: string | null;
  linkUrl?: string | null;
  assets: MarketingAssets;
  unsubscribeUrl?: string | null;
}

export function buildMarketingEmail(input: MarketingEmailInput): { html: string; text: string } {
  const heading = input.heading?.trim() || input.subject;
  const body: Block = { kind: "html", html: input.bodyHtml, text: input.bodyText };
  const link = input.linkUrl && /^https:\/\//.test(input.linkUrl) ? input.linkUrl : null;
  const blocks: Block[] = [];
  switch (input.design) {
    case "spotlight": {
      const l = input.assets.listings[0];
      blocks.push({ kind: "eyebrow", text: l?.place ? `Spotlight · ${l.place.split(", ").pop()}` : "Spotlight" }, { kind: "heading", text: heading }, body);
      if (l) blocks.push({ kind: "listing", listing: l, button: input.buttonLabel?.trim() || "See this place" });
      break;
    }
    case "collection":
      blocks.push({ kind: "heading", text: heading }, body, { kind: "listings", listings: input.assets.listings });
      blocks.push({ kind: "button", label: input.buttonLabel?.trim() || "See more places", url: link ?? siteUrl("/search") });
      break;
    case "offer":
      blocks.push({ kind: "eyebrow", text: "Offer" }, { kind: "heading", text: heading }, body);
      if (input.assets.offer) blocks.push({ kind: "coupon", code: input.assets.offer.code, title: input.assets.offer.title, detail: input.assets.offer.detail ?? undefined });
      blocks.push({ kind: "button", label: input.buttonLabel?.trim() || "Find a place", url: link ?? siteUrl("/search") });
      break;
    case "news":
      if (input.imageUrl) blocks.push({ kind: "image", url: input.imageUrl, alt: heading, href: link ?? undefined });
      blocks.push({ kind: "heading", text: heading }, body);
      if (link) blocks.push({ kind: "button", label: input.buttonLabel?.trim() || "Read more", url: link });
      break;
    default:
      blocks.push({ kind: "heading", text: heading }, body);
      if (link) blocks.push({ kind: "button", label: input.buttonLabel?.trim() || "Open", url: link });
  }
  const email = renderLayout({
    subject: input.subject,
    preheader: input.bodyText.replace(/\s+/g, " ").slice(0, 120),
    blocks,
    footerNote: input.unsubscribeUrl ? `You're getting this because you have a ${env.BRAND_NAME} account and news and offers are switched on.` : undefined,
    unsubscribeUrl: input.unsubscribeUrl,
  });
  return { html: email.html, text: email.text };
}

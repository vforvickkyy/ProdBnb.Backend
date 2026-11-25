import { SupabaseClient } from "@supabase/supabase-js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../errors/AppError";
import { publicUrlFor } from "../../lib/r2";
import { adminClient } from "../../lib/supabase";
import { getVisibleLocationOrNull } from "../locations/locations.service";
import {
  notifyBookingCancelled,
  notifyBookingConfirmed,
  notifyBookingDeclined,
  notifyBookingRequestReceived,
  notifyQuoteReady,
  notifyQuoteRequested,
} from "../notifications/notification.service";
import { BookingType } from "../pricing/pricing.schema";
import { BookingActionInput, CreateBookingInput, ListBookingsQuery, SendQuoteInput } from "./bookings.schema";
import { getPlatformSettings, platformCharges } from "../platform/settings.service";
import { expireUnpaidHolds } from "./holds";
import { openRefundRequestAfterCancellation } from "../account/refundRequests.service";
import { calculateBookingPrice, getActivePricing, requestableOptions } from "./pricing";
import { recordRedemption, resolveCoupon, type AppliedCoupon } from "../coupons/coupons.service";

const EXCLUSION_VIOLATION = "23P01";

/**
 * The payment statuses that mean "this booking has been paid for" (Phase 29.14-D).
 *
 * Not a new rule: this is the exact predicate of the `payments_one_settled_per_booking` partial
 * unique index, so at most one payment per booking can ever match. `refunded`/`partially_refunded`
 * are included deliberately -- money *was* taken, and a refunded booking must not silently vanish
 * from the host's list as though it had never been paid for.
 */
const SETTLED_PAYMENT_STATUSES = ["success", "partially_refunded", "refunded"] as const;

/**
 * Whether a settled payment exists for this booking.
 *
 * Runs on `adminClient` on purpose: this is a business-rule check about money, and it must give the
 * same answer regardless of which caller is asking or what RLS would let them read of `payments`.
 */
async function hasSettledPayment(bookingId: string): Promise<boolean> {
  const { data, error } = await adminClient
    .from("payments")
    .select("id")
    .eq("booking_id", bookingId)
    .in("status", SETTLED_PAYMENT_STATUSES)
    .limit(1);
  if (error) {
    throw error;
  }
  return (data ?? []).length > 0;
}

const BOOKING_COLUMNS = `
  id, location_id, booker_id, booking_type, start_at, end_at, status,
  base_amount_minor_units, platform_fee_minor_units, tax_minor_units, discount_minor_units,
  total_amount_minor_units, currency,
  cancelled_at, cancelled_by, cancellation_reason, hold_expired_at,
  shoot_type_id, shoot_type, crew_size, project_name, production_name, shoot_notes, terms_accepted_at,
  pricing_status, quoted_at,
  created_at, updated_at
`;

// Phase 14: admin list/detail views need booker/host identity and whether a
// payment exists without firing a follow-up request per row -- adding these
// to the one shared select (rather than a second, admin-only query) keeps
// exactly one booking-fetching code path, since every non-admin caller is
// already RLS-restricted to rows they're allowed to see regardless of what
// extra columns are selected. `profiles` has no email column by design
// (Phase 1) -- email lookups go through the Admin Auth API on the User
// detail page instead, not per-row here, which would reintroduce the same
// N+1 problem this join exists to avoid. `booker:profiles!booker_id` is
// disambiguated explicitly because `bookings` has two FKs to `profiles`
// (booker_id and cancelled_by).
// Phase 29.14-B: `region` and the location's general-gallery media join the same
// shared select, for the Booker booking list. Both are for recognition -- a
// booking row shows a photograph and "Chail, Himachal Pradesh" rather than
// "Chail" alone -- and both had to come from the booking payload itself: there
// is no batch-locations-by-ids endpoint (the search query schema is `.strict()`
// with no `ids` param), so a client fetching either per row would be a literal
// N+1. This is the same reasoning, and the same solution, as
// get_conversations_for_viewer()'s `location_primary_media_key` for the Inbox
// list.
//
// `location_media` is embedded raw (key/position/section_id) and reduced to a
// single cover URL in toBookingDetail() -- see primaryMediaUrlFor(). The raw
// rows never leave this module: the storage key is an internal R2 detail, and
// the response carries only `primary_media_url`, exactly as the messaging and
// search modules do.
//
// No RLS change was needed or made. `location_media_select_via_location` gates
// media on precisely the same condition `locations_select_published_or_own_or_admin`
// gates the parent row on (published, or own, or admin), so this embed can never
// surface media for a location the caller could not already see through the
// `locations` embed that has always been here.
const BOOKING_DETAIL_SELECT = `
  ${BOOKING_COLUMNS},
  locations ( id, title, city, region, timezone, host_id,
              host:profiles ( first_name, last_name ),
              location_media ( storage_key, position, section_id ) ),
  booker:profiles!booker_id ( first_name, last_name ),
  payments ( id, status, amount_minor_units, created_at )
`;

interface NameRef {
  first_name: string | null;
  last_name: string | null;
}

/** One embedded `location_media` row, exactly as the select above returns it. */
interface MediaRef {
  storage_key: string;
  position: number;
  section_id: string | null;
}

/**
 * The location as the embed returns it, including the raw media rows.
 *
 * Deliberately distinct from `BookingLocation` below, which is what the API
 * actually returns: `location` used to be passed straight through from the row,
 * and with media embedded that pass-through would have published every storage
 * key in the gallery.
 */
interface RawLocationRef {
  id: string;
  title: string;
  city: string;
  region: string | null;
  timezone: string;
  host_id: string;
  host: NameRef | null;
  location_media: MediaRef[] | null;
}

/** The location shape a booking response carries. */
export interface BookingLocation {
  id: string;
  title: string;
  city: string;
  region: string | null;
  timezone: string;
  host_id: string;
  host: NameRef | null;
  /** The general-gallery cover, or null when the location has no general photo. */
  primary_media_url: string | null;
}

/**
 * The location's cover photo: **general gallery only, lowest position**.
 *
 * The `section_id === null` filter is load-bearing and is the same rule Phase
 * 29.6 added to `search_locations()` and `get_conversations_for_viewer()`.
 * Without it a production-area photo sitting at position 0 -- entirely normal,
 * because positions restart per gallery -- would be served as the location's
 * primary image. A row whose `section_id` is anything other than exactly `null`
 * is excluded, so a missing column fails closed (no cover) rather than
 * promoting a section photo.
 *
 * Ties on `position` are broken by `storage_key` so the answer is deterministic;
 * the SQL `order by position asc limit 1` leaves ties to the planner, and a
 * cover that changes between identical requests would be worse than either
 * choice. The input array is copied rather than sorted in place.
 *
 * Returns `null` -- never a fabricated or placeholder URL -- when there is no
 * general-gallery photo. The key is turned into a URL by the existing
 * `publicUrlFor()`, the same one search and messaging use; no second URL
 * mechanism exists.
 */
function primaryMediaUrlFor(media: MediaRef[] | null | undefined): string | null {
  const general = (media ?? []).filter((m) => m.section_id === null);
  // `reduce` rather than `sort()[0]`: with `noUncheckedIndexedAccess` an indexed
  // read is `T | undefined`, and reducing states the "pick one" intent directly
  // without a non-null assertion.
  const cover = general.reduce<MediaRef | null>((best, m) => {
    if (best === null) return m;
    if (m.position !== best.position) return m.position < best.position ? m : best;
    return m.storage_key.localeCompare(best.storage_key) < 0 ? m : best;
  }, null);
  return cover === null ? null : publicUrlFor(cover.storage_key);
}

/**
 * The booker identity a host is allowed to see (Phase 29.18-F).
 *
 * Comes from `get_booking_participants()`, a SECURITY DEFINER function gated on
 * `locations.host_id = auth.uid()`. It exists because `profiles` RLS is own-row-or-admin, so the
 * `booker:profiles!booker_id (...)` embed in `BOOKING_DETAIL_SELECT` resolves to **null** for a host
 * caller -- PostgREST applies RLS to an embedded resource independently of the parent row. The
 * booking's `booker_id` was never lost; only the name was.
 *
 * Exactly four columns, fixed by the function's signature. Never phone, address, status or any
 * other profile column, and `email` is not reachable at all (it lives in `auth.users`).
 */
export interface BookerProfile {
  id: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
}

/** One row of `get_booking_participants()`, which keys its answer by booking. */
interface BookingParticipantRow extends BookerProfile {
  booking_id: string;
}

interface PaymentSummary {
  id: string;
  status: string;
  amount_minor_units: number;
  created_at: string;
}

interface RawBookingRow {
  id: string;
  location_id: string;
  booker_id: string;
  booking_type: string;
  start_at: string;
  end_at: string;
  status: string;
  base_amount_minor_units: number;
  platform_fee_minor_units: number;
  tax_minor_units: number;
  discount_minor_units: number;
  total_amount_minor_units: number;
  currency: string;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  hold_expired_at: string | null;
  shoot_type_id: string | null;
  shoot_type: string | null;
  crew_size: number | null;
  project_name: string | null;
  production_name: string | null;
  shoot_notes: string | null;
  terms_accepted_at: string | null;
  pricing_status: PricingStatus;
  quoted_at: string | null;
  created_at: string;
  updated_at: string;
  locations: RawLocationRef;
  booker: NameRef | null;
  payments: PaymentSummary[];
}

/**
 * priced: a normal booking. awaiting_quote: a request on a price-on-request listing -- no price yet
 * (all amounts 0), doesn't hold the slot, the host answers with a price or declines. quoted: the host
 * sent a price (status is then `confirmed`) and the booker pays next.
 */
export type PricingStatus = "priced" | "awaiting_quote" | "quoted";

/** What the booker told the host about the shoot. */
export interface ShootDetails {
  /** The use case picked, or null when described in the booker's own words. */
  type_id: string | null;
  /** What the shoot is, e.g. "Music Video" (or the booker's own words). */
  type: string | null;
  /** People on set. */
  crew_size: number | null;
  project_name: string | null;
  production_name: string | null;
  notes: string | null;
  /** When the booker accepted the terms (null when the app that booked didn't ask). */
  terms_accepted_at: string | null;
}

export interface BookingDetail {
  id: string;
  location: BookingLocation;
  booker_id: string;
  booker: NameRef | null;
  booking_type: string;
  start_at: string;
  end_at: string;
  status: string;
  pricing: {
    base_amount_minor_units: number;
    platform_fee_minor_units: number;
    tax_minor_units: number;
    discount_minor_units: number;
    total_amount_minor_units: number;
    currency: string;
  };
  payments: PaymentSummary[];
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  /**
   * Admin Console. Set when this booking was auto-cancelled because payment was not completed
   * within the platform's unpaid-hold window -- how a client tells an expiry apart from a person
   * cancelling. Additive; `null` for every other booking.
   */
  hold_expired_at: string | null;
  /**
   * Phase 29.18-F. Present only when the caller is the **host** of this booking's location.
   *
   * Additive and optional: `booker` above is untouched and still answers for a booker reading
   * their own booking and for an admin, both of whom satisfy `profiles` RLS directly. Removing it
   * would be a regression for both.
   */
  booker_profile?: BookerProfile | null;
  shoot: ShootDetails;
  pricing_status: PricingStatus;
  /** When the host sent the price (quoted requests only). */
  quoted_at: string | null;
}

/**
 * A booker keeps seeing their booking after its listing is archived, suspended or unpublished --
 * but `locations` RLS hides such a listing from them, so the embed comes back null. Fill those in
 * with the same compact summary from the service role (the title and town of a place they booked
 * are theirs to see; host and photos stay hidden). Without this, one archived listing made the
 * booker's whole bookings list fail.
 */
async function withHiddenLocations(rows: RawBookingRow[]): Promise<RawBookingRow[]> {
  const missing = [...new Set(rows.filter((r) => !r.locations).map((r) => r.location_id))];
  if (missing.length === 0) return rows;
  const { data, error } = await adminClient.from("locations").select("id, title, city, region, timezone, host_id").in("id", missing);
  if (error) throw error;
  const byId = new Map((data ?? []).map((l) => [l.id as string, l]));
  return rows.map((r) => {
    if (r.locations) return r;
    const l = byId.get(r.location_id);
    return {
      ...r,
      locations: {
        id: r.location_id,
        title: (l?.title as string | undefined) ?? "Listing no longer available",
        city: (l?.city as string | undefined) ?? "",
        region: (l?.region as string | null | undefined) ?? null,
        timezone: (l?.timezone as string | undefined) ?? "UTC",
        host_id: (l?.host_id as string | undefined) ?? "",
        host: null,
        location_media: null,
      },
    };
  });
}

function toBookingDetail(row: RawBookingRow): BookingDetail {
  return {
    id: row.id,
    // Phase 29.14-B: an explicit projection, not the pass-through this used to
    // be. The embed now carries raw `location_media`, and passing the row
    // straight through would publish every storage key in the gallery. Every
    // pre-existing field is reproduced verbatim; `region` and
    // `primary_media_url` are the only additions.
    location: {
      id: row.locations.id,
      title: row.locations.title,
      city: row.locations.city,
      region: row.locations.region,
      timezone: row.locations.timezone,
      host_id: row.locations.host_id,
      host: row.locations.host,
      primary_media_url: primaryMediaUrlFor(row.locations.location_media),
    },
    booker_id: row.booker_id,
    booker: row.booker,
    booking_type: row.booking_type,
    start_at: row.start_at,
    end_at: row.end_at,
    status: row.status,
    pricing: {
      base_amount_minor_units: row.base_amount_minor_units,
      platform_fee_minor_units: row.platform_fee_minor_units,
      tax_minor_units: row.tax_minor_units,
      discount_minor_units: row.discount_minor_units,
      total_amount_minor_units: row.total_amount_minor_units,
      currency: row.currency,
    },
    payments: row.payments ?? [],
    created_at: row.created_at,
    updated_at: row.updated_at,
    cancelled_at: row.cancelled_at,
    cancelled_by: row.cancelled_by,
    cancellation_reason: row.cancellation_reason,
    hold_expired_at: row.hold_expired_at ?? null,
    shoot: {
      type_id: row.shoot_type_id ?? null,
      type: row.shoot_type ?? null,
      crew_size: row.crew_size ?? null,
      project_name: row.project_name ?? null,
      production_name: row.production_name ?? null,
      notes: row.shoot_notes ?? null,
      terms_accepted_at: row.terms_accepted_at ?? null,
    },
    pricing_status: row.pricing_status ?? "priced",
    quoted_at: row.quoted_at ?? null,
  };
}

/** The shoot details as booking columns; the shoot type is checked against the use-case list. */
async function shootColumns(input: CreateBookingInput): Promise<Record<string, unknown>> {
  let shootTypeId: string | null = null;
  let shootType: string | null = input.shoot_type_other ?? null;
  if (input.shoot_type_id) {
    const { data, error } = await adminClient.from("use_cases").select("id, name").eq("id", input.shoot_type_id).maybeSingle();
    if (error) throw error;
    if (!data) throw new ValidationError("Pick a shoot type from the list.");
    shootTypeId = data.id as string;
    shootType = data.name as string;
  }
  return {
    shoot_type_id: shootTypeId,
    shoot_type: shootType,
    crew_size: input.crew_size ?? null,
    project_name: input.project_name ?? null,
    production_name: input.production_name ?? null,
    shoot_notes: input.shoot_notes ?? null,
    terms_accepted_at: input.accept_terms ? new Date().toISOString() : null,
  };
}

interface ResolvedWindow {
  start_at: string;
  end_at: string;
}

/**
 * The earliest window-start / latest window-end for one calendar date, per
 * `get_location_availability()` — reused as-is, never reimplemented. Used
 * for both `day` (one date) and `multi_day` (check-in/check-out dates).
 * Throws if the location has no availability at all that date, rather than
 * assuming a naive full-day span.
 */
async function daySpan(supabase: SupabaseClient, locationId: string, date: string): Promise<ResolvedWindow> {
  const { data, error } = await supabase.rpc("get_location_availability", {
    _location_id: locationId,
    _from_date: date,
    _to_date: date,
  });
  if (error) {
    throw error;
  }
  const windows = (data ?? []) as ResolvedWindow[];
  if (windows.length === 0) {
    throw new ValidationError(`This location has no availability on ${date}.`);
  }

  let start_at = windows[0]!.start_at;
  let end_at = windows[0]!.end_at;
  for (const w of windows) {
    if (new Date(w.start_at) < new Date(start_at)) start_at = w.start_at;
    if (new Date(w.end_at) > new Date(end_at)) end_at = w.end_at;
  }
  return { start_at, end_at };
}

/**
 * Resolves any of the four booking-type request shapes down to the one
 * thing the database has always protected atomically: a [start_at, end_at)
 * interval. `is_interval_available()`/the EXCLUDE constraint downstream are
 * completely unaware of booking_type — they only ever see the interval this
 * function produces.
 */
async function resolveInterval(
  supabase: SupabaseClient,
  locationId: string,
  input: CreateBookingInput,
  /** A price request already knows the half-day length (its pricing may be switched off). */
  halfDayHours?: number | null
): Promise<ResolvedWindow> {
  switch (input.booking_type) {
    case "hourly":
      return { start_at: input.start_at, end_at: input.end_at };

    case "half_day": {
      // Service role: the caller already passed the visibility check, and a price-on-request
      // listing's pricing rows (which hold the half-day length) are hidden from bookers.
      const hours = halfDayHours ?? (await getActivePricing(adminClient, locationId, "half_day")).half_day_duration_hours;
      if (!hours) {
        throw new ValidationError("This location's half-day pricing has no duration configured.");
      }
      const endAt = new Date(new Date(input.start_at).getTime() + hours * 3_600_000);
      return { start_at: input.start_at, end_at: endAt.toISOString() };
    }

    case "day":
      return daySpan(supabase, locationId, input.date);

    case "multi_day": {
      const [checkIn, checkOut] = await Promise.all([
        daySpan(supabase, locationId, input.start_date),
        daySpan(supabase, locationId, input.end_date),
      ]);
      return { start_at: checkIn.start_at, end_at: checkOut.end_at };
    }
  }
}

/** A price and availability preview for a booking that has not been made (website checkout). */
export interface BookingQuote {
  location_id: string;
  booking_type: BookingType;
  /** False when the time can't be booked; `reason` says why in words a booker understands. */
  available: boolean;
  reason: string | null;
  /** The exact interval the booking would reserve (derived for half-day, day and multi-day). */
  start_at: string | null;
  end_at: string | null;
  timezone: string;
  /** What the listing price is multiplied by: hours, days, or one block. */
  units: { count: number; unit: "hour" | "half_day" | "day" } | null;
  rate_minor_units: number | null;
  pricing: {
    base_amount_minor_units: number;
    platform_fee_minor_units: number;
    tax_minor_units: number;
    discount_minor_units: number;
    total_amount_minor_units: number;
    currency: string;
  } | null;
  /** Confirmed straight away on payment, or a request the host accepts. */
  instant_booking: boolean;
  /** How long an unpaid booking holds the slot (null = no limit). */
  hold_minutes: number | null;
  /** The caller hosts this listing (the website won't offer to book it). */
  own_listing: boolean;
  /** The code that was applied, or null. */
  coupon: { code: string; title: string; discount_minor_units: number; funded_by: "platform" | "host" } | null;
  /** Why the code in the request didn't apply (the price is then shown without it). */
  coupon_error: string | null;
  /**
   * The listing's prices are on request: `pricing` is null and booking sends a request the host
   * answers with a price (nothing is charged until then).
   */
  price_on_request: boolean;
}

/**
 * Website checkout: exactly what `createBooking` would charge and reserve, without creating
 * anything. Same visibility rule, interval derivation, availability check and price calculation;
 * a time that can't be booked is a normal answer (`available: false` with a reason), not an error.
 */
export async function quoteBooking(supabase: SupabaseClient, callerId: string, input: CreateBookingInput): Promise<BookingQuote> {
  const location = await getVisibleLocationOrNull(supabase, input.location_id);
  if (!location || location.status !== "published") {
    throw new NotFoundError("Location not found.");
  }
  const settings = await getPlatformSettings();
  const base: BookingQuote = {
    location_id: input.location_id,
    booking_type: input.booking_type as BookingType,
    available: false,
    reason: null,
    start_at: null,
    end_at: null,
    timezone: location.timezone,
    units: null,
    rate_minor_units: null,
    pricing: null,
    instant_booking: location.instant_booking_enabled,
    hold_minutes: settings.unpaid_hold_minutes,
    own_listing: location.host_id === callerId,
    coupon: null,
    coupon_error: null,
    price_on_request: location.price_on_request,
  };
  const unavailable = (reason: string, extra: Partial<BookingQuote> = {}): BookingQuote => ({ ...base, ...extra, available: false, reason });

  if (location.price_on_request) {
    let requestInterval: ResolvedWindow;
    try {
      const option = await requestOption(input.location_id, input.booking_type as BookingType);
      requestInterval = await resolveInterval(supabase, input.location_id, input, option.half_day_duration_hours);
    } catch (error) {
      if (error instanceof ValidationError) return unavailable(error.message.includes("does not offer") ? "This place doesn't offer that kind of booking." : "The place isn't open then. Pick another date.");
      throw error;
    }
    if (new Date(requestInterval.start_at).getTime() <= Date.now()) {
      return unavailable("That time has already passed.", requestInterval);
    }
    await expireUnpaidHolds(input.location_id);
    const { data: free, error: freeError } = await supabase.rpc("is_interval_available", {
      _location_id: input.location_id,
      _start_at: requestInterval.start_at,
      _end_at: requestInterval.end_at,
    });
    if (freeError) throw freeError;
    const extra: Partial<BookingQuote> = {
      ...requestInterval,
      coupon_error: input.coupon_code ? "Codes can't be used when the price is on request." : null,
    };
    if (!free) return unavailable("Someone has already booked part of that time, or the host closed it. Pick another time.", extra);
    return { ...base, ...extra, available: true, reason: null };
  }

  let interval: ResolvedWindow;
  let rate: Awaited<ReturnType<typeof getActivePricing>>;
  try {
    rate = await getActivePricing(supabase, input.location_id, input.booking_type as BookingType);
    if (rate.amount_minor_units <= 0) {
      throw new ValidationError("This location does not offer that booking type.");
    }
    interval = await resolveInterval(supabase, input.location_id, input);
  } catch (error) {
    if (error instanceof ValidationError) return unavailable(error.message.includes("does not offer") ? "This place doesn't offer that kind of booking." : "The place isn't open then. Pick another date.");
    throw error;
  }
  if (new Date(interval.start_at).getTime() <= Date.now()) {
    return unavailable("That time has already passed.", interval);
  }

  await expireUnpaidHolds(input.location_id);
  const { data: available, error: availabilityError } = await supabase.rpc("is_interval_available", {
    _location_id: input.location_id,
    _start_at: interval.start_at,
    _end_at: interval.end_at,
  });
  if (availabilityError) throw availabilityError;

  const pricing = await calculateBookingPrice(supabase, input.location_id, input.booking_type as BookingType, interval.start_at, interval.end_at, location.timezone);
  let applied: AppliedCoupon | null = null;
  let couponError: string | null = null;
  if (input.coupon_code) {
    const r = await resolveCoupon(input.coupon_code, { locationId: input.location_id, hostId: location.host_id, bookingType: input.booking_type, baseMinor: pricing.base_amount_minor_units, userId: callerId });
    if ("error" in r) couponError = r.error;
    else applied = r;
  }
  const discount = applied?.discount ?? 0;
  const charges = platformCharges(pricing.base_amount_minor_units - discount, settings);
  const hours = (new Date(interval.end_at).getTime() - new Date(interval.start_at).getTime()) / 3_600_000;
  const units: BookingQuote["units"] =
    input.booking_type === "hourly"
      ? { count: Math.round(hours * 100) / 100, unit: "hour" }
      : input.booking_type === "half_day"
        ? { count: 1, unit: "half_day" }
        : { count: rate.amount_minor_units > 0 ? Math.round(pricing.base_amount_minor_units / rate.amount_minor_units) : 1, unit: "day" };
  const priced: Partial<BookingQuote> = {
    ...interval,
    units,
    rate_minor_units: rate.amount_minor_units,
    pricing: {
      base_amount_minor_units: pricing.base_amount_minor_units,
      platform_fee_minor_units: charges.platform_fee_minor_units,
      tax_minor_units: charges.tax_minor_units,
      discount_minor_units: discount,
      total_amount_minor_units: charges.total_amount_minor_units,
      currency: pricing.currency,
    },
    coupon: applied ? { code: applied.coupon.code, title: applied.coupon.title, discount_minor_units: discount, funded_by: applied.coupon.owner_type } : null,
    coupon_error: couponError,
  };
  if (!available) return unavailable("Someone has already booked part of that time, or the host closed it. Pick another time.", priced);
  return { ...base, ...priced, available: true, reason: null };
}

export async function createBooking(
  supabase: SupabaseClient,
  bookerId: string,
  input: CreateBookingInput
): Promise<BookingDetail> {
  const location = await getVisibleLocationOrNull(supabase, input.location_id);
  // A booker may only ever book a live, published listing — even a host or
  // admin previewing their own draft via getVisibleLocationOrNull can't
  // "book" it; that function answers visibility, not bookability.
  if (!location || location.status !== "published") {
    throw new NotFoundError("Location not found.");
  }

  if (location.price_on_request) {
    return createPriceRequest(supabase, bookerId, location, input);
  }

  const interval = await resolveInterval(supabase, input.location_id, input);

  // Admin Console: release any lapsed unpaid hold on this location first, so a slot an abandoned
  // checkout was squatting on is bookable the moment its hold runs out -- not up to a minute later
  // when the pg_cron sweep gets to it. A no-op (no round trip) while expiry is off.
  await expireUnpaidHolds(input.location_id);

  const { data: available, error: availabilityError } = await supabase.rpc("is_interval_available", {
    _location_id: input.location_id,
    _start_at: interval.start_at,
    _end_at: interval.end_at,
  });
  if (availabilityError) {
    throw availabilityError;
  }
  if (!available) {
    throw new ValidationError("The requested time is not available.");
  }

  const pricing = await calculateBookingPrice(
    supabase,
    input.location_id,
    input.booking_type as BookingType,
    interval.start_at,
    interval.end_at,
    location.timezone
  );
  // A type priced at 0 is only bookable as a request (it is hidden from the listing's options).
  if (pricing.base_amount_minor_units <= 0) {
    throw new ValidationError("This location does not offer that booking type.");
  }
  // Offers: a coupon comes off the listing price; the fee and tax are then worked out on the lower
  // price. The booking records the coupon, the discount and who funds it (ProdBnb or the host).
  let applied: AppliedCoupon | null = null;
  if (input.coupon_code) {
    const r = await resolveCoupon(input.coupon_code, { locationId: input.location_id, hostId: location.host_id, bookingType: input.booking_type, baseMinor: pricing.base_amount_minor_units, userId: bookerId });
    if ("error" in r) throw new ValidationError(r.error);
    applied = r;
  }
  const discount = applied?.discount ?? 0;
  // Admin Console: platform fee and tax from platform_settings, applied on top of the location's own
  // price. Both default to 0, in which case `charges.total_amount_minor_units === base` and every
  // booking prices exactly as it always has. The snapshot below records whichever rates applied.
  const charges = platformCharges(pricing.base_amount_minor_units - discount, await getPlatformSettings());
  const status = location.instant_booking_enabled ? "confirmed" : "requested";

  // Every authorization/business-rule check above already ran against the
  // caller's own scoped client (location visibility, availability, pricing)
  // -- the actual insert uses adminClient because `bookings` no longer grants
  // authenticated INSERT at all (Phase 12: a client could otherwise bypass
  // this function entirely via direct PostgREST and fabricate an arbitrary
  // price/status/interval). This does not change WHO may create a booking,
  // only WHERE the write executes from.
  const { data, error } = await adminClient
    .from("bookings")
    .insert({
      location_id: input.location_id,
      booker_id: bookerId,
      booking_type: input.booking_type,
      start_at: interval.start_at,
      end_at: interval.end_at,
      status,
      base_amount_minor_units: pricing.base_amount_minor_units,
      platform_fee_minor_units: charges.platform_fee_minor_units,
      tax_minor_units: charges.tax_minor_units,
      discount_minor_units: discount,
      coupon_id: applied?.coupon.id ?? null,
      discount_funded_by: applied ? applied.coupon.owner_type : null,
      total_amount_minor_units: charges.total_amount_minor_units,
      currency: pricing.currency,
      ...(await shootColumns(input)),
    })
    .select(BOOKING_DETAIL_SELECT)
    .single();

  if (error || !data) {
    // The authoritative guarantee: even though is_interval_available already
    // checked above, a concurrent request can still win the race between
    // that check and this insert — the exclusion constraint is what
    // actually prevents two overlapping active bookings from both existing,
    // regardless of which booking_type either side used to get there.
    if (error?.code === EXCLUSION_VIOLATION) {
      throw new ConflictError("This time was just booked by someone else. Please choose another time.");
    }
    throw error ?? new Error("Failed to create booking.");
  }

  const booking = toBookingDetail(data as unknown as RawBookingRow);
  if (applied) await recordRedemption(applied, booking.id, bookerId);

  // Phase 29.14-D: the host is deliberately NOT notified here.
  //
  // This call used to be `notifyBookingRequestReceived(location.host_id, ...)`, fired
  // unconditionally the moment the row was inserted -- before any payment existed, and indeed
  // before one was even required, since payment is optional and skippable. A host was therefore
  // pushed "You have a new booking request" for a booking nobody had paid for.
  //
  // The host request is now raised from the payment's own settlement point instead
  // (`applyPaymentStatusUpdate` in payment.service.ts), which is the only server-authoritative
  // confirmation the system has. Nothing about the booking's *status* changed: it is still
  // `requested`/`confirmed` here, it still reserves the slot through the exclusion constraint, and
  // `initiatePayment` still accepts it. Only host VISIBILITY and the host NOTIFICATION moved.
  if (booking.status === "confirmed") {
    // instant_booking_enabled skipped host approval -- the booker should
    // still be told their booking is confirmed.
    await notifyBookingConfirmed(bookerId, booking.id);
  }

  return booking;
}

/**
 * Whether a price-on-request listing can be asked about this booking type (see
 * `requestableOptions`), with its half-day length and the currency the host will quote in. Read
 * with the service role: the caller already passed the visibility check, and a price-on-request
 * listing's pricing rows are hidden from bookers.
 */
async function requestOption(locationId: string, type: BookingType): Promise<{ currency: string; half_day_duration_hours: number | null }> {
  const { data, error } = await adminClient
    .from("location_pricing")
    .select("booking_type, currency, is_active, half_day_duration_hours")
    .eq("location_id", locationId);
  if (error) throw error;
  const rows = (data ?? []) as { booking_type: string; currency: string; is_active: boolean; half_day_duration_hours: number | null }[];
  const option = requestableOptions(rows).find((o) => o.type === type);
  if (!option) {
    throw new ValidationError(`This location does not offer '${type}' bookings.`);
  }
  return { currency: rows[0]?.currency ?? "INR", half_day_duration_hours: option.half_day_duration_hours ?? null };
}

/**
 * A booking on a price-on-request listing: a request with no price (all amounts 0) that the host
 * answers with a price (`sendQuote`) or declines. It doesn't hold the slot until it is priced -- so
 * nobody can block a date for free -- and the host is told straight away, since there is nothing
 * to pay yet. No coupons: there is no price to take them off.
 */
async function createPriceRequest(
  supabase: SupabaseClient,
  bookerId: string,
  location: { id: string; host_id: string },
  input: CreateBookingInput
): Promise<BookingDetail> {
  if (input.coupon_code) {
    throw new ValidationError("Codes can't be used when the price is on request.");
  }
  if (!input.shoot_type_id && !input.shoot_type_other) {
    throw new ValidationError("Tell the host what the shoot is.");
  }
  if (!input.crew_size) {
    throw new ValidationError("Tell the host how many people will be on set.");
  }
  const option = await requestOption(location.id, input.booking_type as BookingType);
  const interval = await resolveInterval(supabase, location.id, input, option.half_day_duration_hours);
  if (new Date(interval.start_at).getTime() <= Date.now()) {
    throw new ValidationError("That time has already passed.");
  }
  await expireUnpaidHolds(location.id);
  const { data: available, error: availabilityError } = await supabase.rpc("is_interval_available", {
    _location_id: location.id,
    _start_at: interval.start_at,
    _end_at: interval.end_at,
  });
  if (availabilityError) throw availabilityError;
  if (!available) {
    throw new ValidationError("The requested time is not available.");
  }

  const { data, error } = await adminClient
    .from("bookings")
    .insert({
      location_id: location.id,
      booker_id: bookerId,
      booking_type: input.booking_type,
      start_at: interval.start_at,
      end_at: interval.end_at,
      status: "requested",
      pricing_status: "awaiting_quote",
      base_amount_minor_units: 0,
      platform_fee_minor_units: 0,
      tax_minor_units: 0,
      discount_minor_units: 0,
      total_amount_minor_units: 0,
      currency: option.currency,
      ...(await shootColumns(input)),
    })
    .select(BOOKING_DETAIL_SELECT)
    .single();
  if (error || !data) {
    throw error ?? new Error("Failed to create booking request.");
  }
  const [row] = await withHiddenLocations([data as unknown as RawBookingRow]);
  const booking = toBookingDetail(row!);
  await notifyQuoteRequested(location.host_id, booking.id);
  return booking;
}

/**
 * The host's answer to a price request: their price (before the platform fee and tax, worked out
 * here exactly as for any booking). The booking becomes `confirmed` + `quoted` -- the host has
 * accepted by pricing it -- and from then on holds the slot; the booker pays to finish. If the time
 * was taken meanwhile (another request was priced first, or the host closed it) this is refused and
 * the host can decline the request instead.
 */
export async function sendQuote(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  bookingId: string,
  input: SendQuoteInput
): Promise<BookingDetail> {
  const { row, isHost } = await loadBookingAccess(supabase, callerId, bookingId);
  if (!isHost && !isAdmin) {
    throw new ForbiddenError("Only the host can send a price.");
  }
  if (row.status !== "requested" || row.pricing_status !== "awaiting_quote") {
    throw new ValidationError("This request isn't waiting for a price.");
  }
  if (new Date(row.start_at).getTime() <= Date.now()) {
    throw new ValidationError("This request's time has already passed.");
  }
  const { data: available, error: availabilityError } = await adminClient.rpc("is_interval_available", {
    _location_id: row.location_id,
    _start_at: row.start_at,
    _end_at: row.end_at,
  });
  if (availabilityError) throw availabilityError;
  if (!available) {
    throw new ConflictError("That time is no longer free (another booking or a closed period). Decline this request instead.");
  }
  const charges = platformCharges(input.amount_minor_units, await getPlatformSettings());
  let booking: BookingDetail;
  try {
    booking = await transitionBooking(bookingId, "requested", {
      status: "confirmed",
      pricing_status: "quoted",
      quoted_at: new Date().toISOString(),
      base_amount_minor_units: input.amount_minor_units,
      platform_fee_minor_units: charges.platform_fee_minor_units,
      tax_minor_units: charges.tax_minor_units,
      discount_minor_units: 0,
      total_amount_minor_units: charges.total_amount_minor_units,
    });
  } catch (error) {
    if ((error as { code?: string }).code === EXCLUSION_VIOLATION) {
      throw new ConflictError("That time was just booked by someone else. Decline this request instead.");
    }
    throw error;
  }
  await notifyQuoteReady(booking.booker_id, booking.id);
  return booking;
}

/**
 * The booker identity for a set of bookings, keyed by booking id (Phase 29.18-F).
 *
 * **One call for a whole page, never one per row.** The function takes an array precisely so a
 * Host Bookings page costs one extra round trip rather than N -- the same reason
 * `get_conversations_for_viewer()` renders an entire Inbox in a single call.
 *
 * Runs on the **caller's** client, not `adminClient`, and that is the point: `auth.uid()` inside
 * the function is the requesting user, so the `l.host_id = auth.uid()` gate is what decides the
 * answer. Handing this to `adminClient` would move a cross-user identity gate out of the database
 * and into a TypeScript `if`.
 *
 * An empty input short-circuits: PostgREST would happily accept `{}` but there is nothing to ask.
 */
async function fetchBookerProfiles(
  supabase: SupabaseClient,
  bookingIds: string[]
): Promise<Map<string, BookerProfile>> {
  const byBooking = new Map<string, BookerProfile>();
  if (bookingIds.length === 0) {
    return byBooking;
  }
  const { data, error } = await supabase.rpc("get_booking_participants", { _booking_ids: bookingIds });
  if (error) {
    throw error;
  }
  for (const row of (data ?? []) as BookingParticipantRow[]) {
    // `id` is null when the booking's booker has no profile row -- impossible today (there is an
    // FK) but the LEFT JOIN makes it expressible, and a row of nulls must not become a fake person.
    if (row.id === null) {
      continue;
    }
    byBooking.set(row.booking_id, {
      id: row.id,
      first_name: row.first_name,
      last_name: row.last_name,
      avatar_url: row.avatar_url,
    });
  }
  return byBooking;
}

/**
 * Attaches the host-visible booker identity to bookings that have one.
 *
 * A booking with no entry is returned **unchanged** -- `booker_profile` is simply absent rather
 * than explicitly null, so a caller who is not the host sees exactly the response shape they saw
 * before Phase 29.18-F.
 */
function withBookerProfiles(bookings: BookingDetail[], byBooking: Map<string, BookerProfile>): BookingDetail[] {
  return bookings.map((booking) => {
    const profile = byBooking.get(booking.id);
    return profile ? { ...booking, booker_profile: profile } : booking;
  });
}

export interface PaginatedBookings {
  data: BookingDetail[];
  total: number;
}

/**
 * Options for `listBookings` (Phase 29.14-D).
 *
 * `includeUnpaidForHost` exists so **admin oversight is never gated**. `GET /v1/admin/bookings` is a
 * thin wrapper over this same function, and `host_id` is in practice an admin filter -- an admin
 * investigating a host's bookings must still see the unpaid ones, which are precisely the ones worth
 * investigating. The payment gate is a rule about what a HOST is asked to act on, not a rule about
 * what exists.
 */
export interface ListBookingsOptions {
  includeUnpaidForHost?: boolean;
}

export async function listBookings(
  supabase: SupabaseClient,
  query: ListBookingsQuery,
  options: ListBookingsOptions = {}
): Promise<PaginatedBookings> {
  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  // PostgREST only treats an embedded-resource filter as row-restricting
  // (rather than just filtering what appears inside the nested object) when
  // the embed is marked `!inner` -- the default embed filters the nested
  // relation only, leaving every outer row in place regardless. Safe to
  // switch unconditionally on host_id specifically: bookings.location_id is
  // NOT NULL, so every booking has exactly one location, and this caller
  // (host_id is admin-only in practice) already has full RLS visibility
  // into locations -- an inner join here can never drop a row it shouldn't.
  // Phase 29.14-D: a host must never be shown a booking nobody has paid for.
  //
  // `payments!inner` + the settled-status filter below is what makes that row-restricting rather
  // than merely filtering the nested array -- the same PostgREST rule, and the same technique,
  // already relied on for `locations!inner` above. A booking with no payment row at all, or with
  // only `created`/`pending`/`failed`/`cancelled` attempts, simply does not join and is absent from
  // the host's results.
  //
  // "Settled" is `success | partially_refunded | refunded`, which is not a definition invented here:
  // it is the exact predicate of the `payments_one_settled_per_booking` unique index
  // (20260903183804_phase12_hardening.sql), so at most one row can ever match per booking and the
  // join cannot duplicate a booking.
  //
  // Booker-scoped queries are untouched: a booker must keep seeing their own unpaid booking, which
  // is precisely how they get back to it to finish paying.
  const gateOnPayment = Boolean(query.host_id) && !options.includeUnpaidForHost;
  let select = BOOKING_DETAIL_SELECT;
  if (query.host_id) {
    select = select.replace("locations (", "locations!inner (");
  }
  // Price requests are the exception: a request waiting for a price, or priced and waiting for
  // payment, is exactly what the host has to act on (or wait for), so it is listed unpaid. The gate is
  // therefore "has a settled payment OR is a price request", expressed as PostgREST's embedded
  // not-null filter inside an `or` (see below) rather than `payments!inner`.
  // Admin Console payment_state filter. A separately-aliased embed, so the `payments` array every
  // booking already carries is never filtered by it: `!inner` + settled statuses keeps only paid
  // bookings; a plain embed filtered to settled statuses and then required to be empty (`is null`,
  // PostgREST's anti-join) keeps only unpaid ones.
  if (query.payment_state === "paid") {
    select = `${select}, settled_payments:payments!inner ( id )`;
  } else if (query.payment_state === "unpaid" || query.payment_state === "unpaid_hold") {
    select = `${select}, settled_payments:payments ( id )`;
  }
  let request = supabase.from("bookings").select(select, { count: "exact" });
  if (gateOnPayment) {
    request = request
      .in("payments.status", SETTLED_PAYMENT_STATUSES)
      .or("payments.not.is.null,pricing_status.neq.priced");
  }
  if (query.payment_state) {
    request = request.in("settled_payments.status", SETTLED_PAYMENT_STATUSES);
    if (query.payment_state === "unpaid" || query.payment_state === "unpaid_hold") {
      request = request.is("settled_payments", null);
    }
    if (query.payment_state === "unpaid_hold") {
      request = request.in("status", ["requested", "confirmed"]);
    }
  }
  if (query.location_id) {
    request = request.eq("location_id", query.location_id);
  }
  if (query.status) {
    request = request.eq("status", query.status);
  }
  if (query.booker_id) {
    request = request.eq("booker_id", query.booker_id);
  }
  if (query.host_id) {
    request = request.eq("locations.host_id", query.host_id);
  }
  if (query.start_after) {
    request = request.gte("start_at", query.start_after);
  }
  if (query.start_before) {
    request = request.lte("start_at", query.start_before);
  }

  // Phase 29.14-D: newest booking first, by when it was MADE.
  //
  // This was `start_at` -- the shoot date -- which meant a booking made today for a shoot next year
  // outranked one made a minute ago for next week, and "newest first" was simply not what the list
  // showed. Ordering here rather than in the client is what keeps pagination globally correct: a
  // page-2 row can never be newer than a page-1 row, which no amount of per-page sorting in Swift
  // could guarantee.
  //
  // `sort=start_at_desc` preserves the old ordering for any caller that wants the shoot-date view;
  // the parameter is optional and defaults to `created_at_desc`.
  const orderColumn = query.sort === "start_at_desc" ? "start_at" : "created_at";
  const { data, error, count } = await request.order(orderColumn, { ascending: false }).range(from, to);
  if (error) {
    throw error;
  }

  const bookings = (await withHiddenLocations((data ?? []) as unknown as RawBookingRow[])).map(toBookingDetail);

  // Phase 29.18-F: one RPC for the whole page, merged by booking id. The function answers only for
  // bookings on the caller's own listings, so for a booker or an admin this returns an empty map
  // and every booking is passed through untouched.
  const bookerProfiles = await fetchBookerProfiles(supabase, bookings.map((b) => b.id));

  return {
    data: withBookerProfiles(bookings, bookerProfiles),
    total: count ?? 0,
  };
}

export async function getBooking(supabase: SupabaseClient, bookingId: string): Promise<BookingDetail> {
  const { data, error } = await supabase.from("bookings").select(BOOKING_DETAIL_SELECT).eq("id", bookingId).single();
  if (error || !data) {
    throw new NotFoundError("Booking not found.");
  }
  const [row] = await withHiddenLocations([data as unknown as RawBookingRow]);
  const booking = toBookingDetail(row!);
  // Phase 29.18-F: the same RPC, with a one-element array. Absent for anyone who is not this
  // booking's host.
  const bookerProfiles = await fetchBookerProfiles(supabase, [booking.id]);
  return withBookerProfiles([booking], bookerProfiles)[0] ?? booking;
}

interface BookingAccess {
  row: {
    id: string;
    location_id: string;
    booker_id: string;
    status: string;
    pricing_status: PricingStatus;
    start_at: string;
    end_at: string;
  };
  isBooker: boolean;
  isHost: boolean;
}

// No isAdmin parameter needed here: RLS on `bookings` already lets an admin's
// scoped client see any row, so a missing row (data === null) genuinely
// means "doesn't exist or isn't visible to this caller at all" regardless
// of role — the isAdmin check only matters afterward, for which *action*
// each caller may perform on a row they can already see.
async function loadBookingAccess(supabase: SupabaseClient, callerId: string, bookingId: string): Promise<BookingAccess> {
  const { data, error } = await supabase
    .from("bookings")
    .select("id, location_id, booker_id, status, pricing_status, start_at, end_at")
    .eq("id", bookingId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Booking not found.");
  }

  const isBooker = data.booker_id === callerId;
  let isHost = false;
  if (!isBooker) {
    const location = await getVisibleLocationOrNull(supabase, data.location_id);
    isHost = location?.host_id === callerId;
  }

  return { row: data as BookingAccess["row"], isBooker, isHost };
}

// Writes via adminClient (Phase 12: `bookings` no longer grants authenticated
// UPDATE at all, for the same reason createBooking's insert moved -- a client
// could otherwise PATCH its own booking's price/status directly). The
// `expectedStatus` compare-and-swap guard is a separate, smaller fix: without
// it, two concurrent transitions on the same booking (e.g. a host reject
// racing an admin confirm) could both pass their earlier status check and
// then both silently apply, with contradictory notifications firing for
// each. Every caller already knows the status it validated against, from the
// loadBookingAccess() read immediately before calling this.
async function transitionBooking(
  bookingId: string,
  expectedStatus: string,
  patch: Record<string, unknown>
): Promise<BookingDetail> {
  const { data, error } = await adminClient
    .from("bookings")
    .update(patch)
    .eq("id", bookingId)
    .eq("status", expectedStatus)
    .select(BOOKING_DETAIL_SELECT)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new ConflictError("This booking's status just changed -- please refresh and try again.");
  }
  const [row] = await withHiddenLocations([data as unknown as RawBookingRow]);
  return toBookingDetail(row!);
}

export async function confirmBooking(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  bookingId: string
): Promise<BookingDetail> {
  const { row, isHost } = await loadBookingAccess(supabase, callerId, bookingId);
  if (!isHost && !isAdmin) {
    throw new ForbiddenError("Only the host or an admin can confirm a booking.");
  }
  if (row.status !== "requested") {
    throw new ValidationError(`Cannot confirm a booking with status '${row.status}'.`);
  }
  if (row.pricing_status === "awaiting_quote") {
    throw new ValidationError("This is a price request: send a price to accept it.");
  }
  if (!isAdmin && !(await hasSettledPayment(bookingId))) {
    // Phase 29.14-D defence in depth: the host list already excludes unpaid bookings, but the gate
    // must not be a property of one query's shape. A host who reached this id another way still
    // cannot act on a booking nobody has paid for.
    //
    // Admins are exempt for the same reason they are exempt from the list gate: this restricts what
    // a HOST is asked to act on, and an admin resolving a stuck booking must not be locked out of it.
    throw new ValidationError("This booking has not been paid for yet.");
  }
  const booking = await transitionBooking(bookingId, row.status, { status: "confirmed" });
  await notifyBookingConfirmed(booking.booker_id, booking.id);
  return booking;
}

export async function rejectBooking(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  bookingId: string,
  input: BookingActionInput
): Promise<BookingDetail> {
  const { row, isHost } = await loadBookingAccess(supabase, callerId, bookingId);
  if (!isHost && !isAdmin) {
    throw new ForbiddenError("Only the host or an admin can reject a booking.");
  }
  if (row.status !== "requested") {
    throw new ValidationError(`Cannot reject a booking with status '${row.status}'.`);
  }
  // A price request has nothing to pay yet -- the host declines it straight away.
  if (!isAdmin && row.pricing_status !== "awaiting_quote" && !(await hasSettledPayment(bookingId))) {
    // Phase 29.14-D defence in depth: the host list already excludes unpaid bookings, but the gate
    // must not be a property of one query's shape. A host who reached this id another way still
    // cannot act on a booking nobody has paid for.
    //
    // Admins are exempt for the same reason they are exempt from the list gate: this restricts what
    // a HOST is asked to act on, and an admin resolving a stuck booking must not be locked out of it.
    throw new ValidationError("This booking has not been paid for yet.");
  }
  const booking = await transitionBooking(bookingId, row.status, {
    status: "rejected",
    cancellation_reason: input.reason ?? null,
  });
  await notifyBookingDeclined(booking.booker_id, booking.id);
  // Booker account: money was taken for a booking that won't happen -- queue it for the team.
  await openRefundRequestAfterCancellation({
    bookingId: booking.id,
    bookerId: booking.booker_id,
    source: "rejection",
    reason: input.reason ?? null,
    cancelledBy: callerId,
  });
  return booking;
}

export async function completeBooking(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  bookingId: string
): Promise<BookingDetail> {
  const { row, isHost } = await loadBookingAccess(supabase, callerId, bookingId);
  if (!isHost && !isAdmin) {
    throw new ForbiddenError("Only the host or an admin can complete a booking.");
  }
  if (row.status !== "confirmed") {
    throw new ValidationError(`Cannot complete a booking with status '${row.status}'.`);
  }
  return transitionBooking(bookingId, row.status, { status: "completed" });
}

export async function cancelBooking(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  bookingId: string,
  input: BookingActionInput
): Promise<BookingDetail> {
  const { row, isBooker, isHost } = await loadBookingAccess(supabase, callerId, bookingId);
  if (!isBooker && !isHost && !isAdmin) {
    throw new ForbiddenError("You do not have permission to cancel this booking.");
  }
  if (row.status !== "requested" && row.status !== "confirmed") {
    throw new ValidationError(`Cannot cancel a booking with status '${row.status}'.`);
  }
  const booking = await transitionBooking(bookingId, row.status, {
    status: "cancelled",
    cancelled_at: new Date().toISOString(),
    cancelled_by: callerId,
    cancellation_reason: input.reason ?? null,
  });

  // Notify whichever party did NOT do the cancelling -- the booker cancelling
  // notifies the host, the host (or an admin) cancelling notifies the booker.
  if (isBooker) {
    const location = await getVisibleLocationOrNull(supabase, row.location_id);
    if (location) {
      await notifyBookingCancelled(location.host_id, booking.id, "host");
    }
  } else {
    await notifyBookingCancelled(booking.booker_id, booking.id);
  }

  // Booker account: a paid booking that was cancelled (by anyone) opens a refund request for the
  // team to decide. Nothing happens for an unpaid booking.
  await openRefundRequestAfterCancellation({
    bookingId: booking.id,
    bookerId: booking.booker_id,
    source: "cancellation",
    reason: input.reason ?? null,
    cancelledBy: callerId,
  });

  return booking;
}

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
} from "../notifications/notification.service";
import { BookingType } from "../pricing/pricing.schema";
import { BookingActionInput, CreateBookingInput, ListBookingsQuery } from "./bookings.schema";
import { getPlatformSettings, platformCharges } from "../platform/settings.service";
import { expireUnpaidHolds } from "./holds";
import { openRefundRequestAfterCancellation } from "../account/refundRequests.service";
import { calculateBookingPrice, getActivePricing } from "./pricing";

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
  created_at: string;
  updated_at: string;
  locations: RawLocationRef;
  booker: NameRef | null;
  payments: PaymentSummary[];
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
  input: CreateBookingInput
): Promise<ResolvedWindow> {
  switch (input.booking_type) {
    case "hourly":
      return { start_at: input.start_at, end_at: input.end_at };

    case "half_day": {
      const pricing = await getActivePricing(supabase, locationId, "half_day");
      if (pricing.half_day_duration_hours === null) {
        throw new ValidationError("This location's half-day pricing has no duration configured.");
      }
      const endAt = new Date(new Date(input.start_at).getTime() + pricing.half_day_duration_hours * 3_600_000);
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
  // Admin Console: platform fee and tax from platform_settings, applied on top of the location's own
  // price. Both default to 0, in which case `charges.total_amount_minor_units === base` and every
  // booking prices exactly as it always has. The snapshot below records whichever rates applied.
  const charges = platformCharges(pricing.base_amount_minor_units, await getPlatformSettings());
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
      total_amount_minor_units: charges.total_amount_minor_units,
      currency: pricing.currency,
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
  if (gateOnPayment) {
    select = select.replace("payments (", "payments!inner (");
  }
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
    request = request.in("payments.status", SETTLED_PAYMENT_STATUSES);
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
  row: { id: string; location_id: string; booker_id: string; status: string };
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
    .select("id, location_id, booker_id, status")
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

  return { row: data, isBooker, isHost };
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
  if (!isAdmin && !(await hasSettledPayment(bookingId))) {
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
      await notifyBookingCancelled(location.host_id, booking.id);
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

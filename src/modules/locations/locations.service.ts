import { SupabaseClient } from "@supabase/supabase-js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { publicUrlFor } from "../../lib/r2";
import { writeAuditLog } from "../admin/audit.service";
import { CreateLocationInput, UpdateLocationInput } from "./locations.schema";
import { requestableOptions } from "../bookings/pricing";

const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";

// base_price_minor_units/currency (Phase 6) are deliberately not selected
// here anymore — location_pricing (Phase 6A) is the sole pricing source now.
// The columns still exist in the database (never dropped) but the app layer
// stops reading/writing them, so there's no way for the two to disagree.
// moderation_reason (Phase 11) is safe to include in this shared select even
// though it can carry admin-written text: it is only ever non-null in the
// same UPDATE that moves status away from 'published' (reject/suspend), and
// cleared in the same UPDATE that moves it back (approve/restore) — a
// publicly-visible (published) row therefore always has moderation_reason
// null by construction, never leaking anything through the public detail/
// search response. See src/modules/admin/locations.service.ts.
//
// Address privacy (migration 20261118150000): address_line1/address_line2/postal_code/latitude/
// longitude are NOT readable by anon/authenticated any more. Every read of these columns therefore
// runs on the service role, AFTER the caller's own client has shown the row is visible to them
// (`visibleRow`) -- RLS still decides who sees a listing at all; the service role only fills in
// columns. What a non-owner then gets to see is decided by `forViewer`.
const LOCATION_COLUMNS = `
  id, host_id, title, description,
  address_line1, address_line2, city, region, country, postal_code, area,
  latitude, longitude, public_latitude, public_longitude, show_exact_location,
  capacity, timezone, instant_booking_enabled, price_on_request,
  listing_code, area_sqft, set_count, parking_spaces, restroom_count, electricity,
  permission_needed, permission_details, custom_amenities, custom_rules, props,
  status, moderation_reason, suspended_by_host_suspension, created_at, updated_at
`;

/** Radius of the circle maps draw around an approximate location, in metres. */
export const APPROXIMATE_RADIUS_M = 2000;

const LOCATION_DETAIL_SELECT = `
  ${LOCATION_COLUMNS},
  location_categories ( categories ( id, name ) ),
  location_amenities ( amenities ( id, name, kind, group_name, position ) ),
  location_use_cases ( use_cases ( id, name ) ),
  location_media ( id, media_type, storage_key, position, metadata, created_at, updated_at ),
  location_pricing ( booking_type, amount_minor_units, currency, is_active, half_day_duration_hours )
`;

// A host may only request these transitions through the general-purpose
// PATCH endpoint; anything else from a non-admin caller is 403. Admins may
// set any of the 8 statuses. Kept deliberately small — a full workflow
// engine is explicitly a later-phase concern.
//
// Website host tools: a listing the team sent back (`rejected`) can be fixed and resubmitted, and an
// archived one relisted -- both go back through review (`submitted`), never straight to published.
const HOST_ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ["submitted"],
  submitted: ["draft"],
  published: ["archived"],
  rejected: ["submitted"],
  archived: ["submitted"],
};

const REQUIRED_FOR_SUBMISSION = ["title", "description", "city", "country", "latitude", "longitude"] as const;

export interface LocationSummary {
  id: string;
  host_id: string;
  title: string;
  description: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string;
  region: string | null;
  country: string;
  postal_code: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Neighbourhood shown before booking, e.g. "Bandra West". */
  area: string | null;
  /** The point maps show before booking (approximate, or exact when show_exact_location). */
  public_latitude: number | null;
  public_longitude: number | null;
  /** Set by the team: full address and exact pin visible before booking. */
  show_exact_location: boolean;
  /** Prices hidden; a booking is a request the host answers with a price. */
  price_on_request: boolean;
  capacity: number | null;
  /** Internal listing ID (HKLS01). Only the host and the team get it; null for everyone else. */
  listing_code: string | null;
  area_sqft: number | null;
  set_count: number | null;
  parking_spaces: number | null;
  restroom_count: number | null;
  electricity: "included" | "extra" | "not_available" | null;
  permission_needed: boolean | null;
  permission_details: string | null;
  custom_amenities: string[];
  custom_rules: string[];
  props: ListingProp[];
  timezone: string;
  instant_booking_enabled: boolean;
  status: string;
  moderation_reason: string | null;
  // Only visible to the location's own host or an admin (locations SELECT
  // RLS restricts a non-published row to those two anyway) -- distinguishes
  // "your host account was suspended" from "this specific listing was
  // suspended" so the moderation UI can show the right explanation (Phase
  // 14; the underlying column and cascade logic are unchanged from Phase 11).
  suspended_by_host_suspension: boolean;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface CatalogRef {
  id: string;
  name: string;
}

/** An amenity or an "allowed here" rule: tick boxes, grouped and in a set order. */
export interface AmenityRef extends CatalogRef {
  group_name: string | null;
  position: number;
}

/** A prop that comes with the listing, or that the host can provide for an extra price. */
export interface ListingProp {
  name: string;
  kind: "included" | "addon";
  price_minor_units: number | null;
  price_unit: "per_booking" | "per_hour" | "per_day" | null;
  note: string | null;
}

export interface HostPublicSummary {
  id: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
}

/**
 * Raw shape as stored/queried — never returned to a client (storage_key is an internal R2 detail).
 *
 * Exported since Phase 29 B2.5-a: `reorder_location_media()` returns
 * `setof public.location_media`, so the media service maps those raw rows through
 * `toPublicMediaItem` exactly as `flattenDetail` already does here.
 */
export interface RawLocationMediaRow {
  id: string;
  media_type: "photo" | "video";
  storage_key: string;
  position: number;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

/** Public-facing shape: a computed `url`, never the raw storage key. */
export interface PublicMediaItem {
  id: string;
  media_type: "photo" | "video";
  url: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export function toPublicMediaItem(row: RawLocationMediaRow): PublicMediaItem {
  return {
    id: row.id,
    media_type: row.media_type,
    url: publicUrlFor(row.storage_key),
    position: row.position,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface BookingOption {
  type: string;
  amount_minor_units: number;
  currency: string;
  /** Half-day options only. */
  half_day_duration_hours?: number | null;
}

interface RawLocationPricingRow {
  booking_type: string;
  amount_minor_units: number;
  currency: string;
  is_active: boolean;
  half_day_duration_hours?: number | null;
}

export interface LocationDetail extends LocationSummary {
  categories: CatalogRef[];
  amenities: AmenityRef[];
  /** The "allowed here" rules the host ticked (outside catering, night shoots...). */
  rules: AmenityRef[];
  use_cases: CatalogRef[];
  media: PublicMediaItem[];
  host: HostPublicSummary | null;
  /** Bookable types with their prices. Empty for a price-on-request listing (prices are hidden). */
  booking_options: BookingOption[];
  /**
   * The booking types that can be chosen, priced or not -- what a request form offers (a
   * price-on-request listing has no `booking_options`). Half-day options say how long they are.
   */
  bookable_options: { type: string; half_day_duration_hours?: number | null }[];
  /**
   * How exact latitude/longitude in THIS response are: "approximate" means a point up to ~1.4 km
   * away from the real spot, to be drawn as a circle of `approximate_radius_m`, never as a pin.
   */
  location_precision: "exact" | "approximate";
  approximate_radius_m: number | null;
}

/** Who is reading a listing -- decides whether the street address and exact pin are included. */
export interface LocationViewer {
  userId: string | null;
  isAdmin: boolean;
}

export const PUBLIC_VIEWER: LocationViewer = { userId: null, isAdmin: false };

function seesEverything(location: Pick<LocationSummary, "host_id">, viewer: LocationViewer): boolean {
  return viewer.isAdmin || (viewer.userId !== null && viewer.userId === location.host_id);
}

/**
 * The listing as `viewer` may see it. The host and the team see everything. Everyone else sees the
 * town, region and area, and an approximate point -- the street, postcode and real pin come with a
 * confirmed, paid booking (bookings/contacts.ts) -- unless the team marked the listing
 * "show exact location". A price-on-request listing shows no prices to them.
 */
export function forViewer<T extends LocationSummary>(location: T, viewer: LocationViewer): T {
  if (seesEverything(location, viewer)) {
    return location;
  }
  // The listing ID is internal: only the host and the team see it, even on a listing whose exact
  // address is public.
  const hidden = { ...location, listing_code: null };
  if (location.show_exact_location) {
    return hidden;
  }
  return {
    ...hidden,
    address_line1: null,
    address_line2: null,
    postal_code: null,
    latitude: location.public_latitude,
    longitude: location.public_longitude,
  };
}

function precisionFor(location: LocationSummary, viewer: LocationViewer): Pick<LocationDetail, "location_precision" | "approximate_radius_m"> {
  const exact = seesEverything(location, viewer) || location.show_exact_location;
  return { location_precision: exact ? "exact" : "approximate", approximate_radius_m: exact ? null : APPROXIMATE_RADIUS_M };
}

interface RawLocationDetailRow extends LocationSummary {
  location_categories: { categories: CatalogRef }[];
  location_amenities: { amenities: AmenityRef & { kind: "amenity" | "rule" } }[];
  location_use_cases: { use_cases: CatalogRef }[];
  location_media: RawLocationMediaRow[];
  location_pricing: RawLocationPricingRow[];
}

function sortedAmenityRefs(rows: RawLocationDetailRow["location_amenities"], kind: "amenity" | "rule"): AmenityRef[] {
  return rows
    .map((r) => r.amenities)
    .filter((a) => (a.kind ?? "amenity") === kind)
    .map((a) => ({ id: a.id, name: a.name, group_name: a.group_name ?? null, position: a.position ?? 0 }))
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

function flattenDetail(row: RawLocationDetailRow, host: HostPublicSummary | null, viewer: LocationViewer): LocationDetail {
  const { location_categories, location_amenities, location_use_cases, location_media, location_pricing, ...summary } =
    row as RawLocationDetailRow;
  const active = location_pricing.filter((p) => p.is_active);
  const hidePrices = summary.price_on_request && !seesEverything(summary, viewer);
  return {
    ...forViewer(summary as LocationSummary, viewer),
    ...precisionFor(summary as LocationSummary, viewer),
    categories: location_categories.map((r) => r.categories),
    amenities: sortedAmenityRefs(location_amenities, "amenity"),
    rules: sortedAmenityRefs(location_amenities, "rule"),
    use_cases: location_use_cases.map((r) => r.use_cases),
    media: location_media.map(toPublicMediaItem).sort((a, b) => a.position - b.position),
    host,
    // Active pricing only — booking_options is a marketplace/booking-facing
    // field, not a management one, so it's filtered the same way regardless
    // of who's viewing (the owner/admin management view of inactive pricing
    // configs lives at GET /v1/locations/:id/pricing, not here).
    //
    // A type priced at 0 is only bookable as a request: on a listing with prices showing it is left
    // out, so it can never be booked for free. On a price-on-request listing the prices are hidden
    // from bookers altogether (`bookable_options` still says which types can be asked for).
    booking_options: hidePrices
      ? []
      : active
      .filter((p) => summary.price_on_request || p.amount_minor_units > 0)
      // A half-day option also says how long it is (the website offers start times that fit).
      .map((p) => ({
        type: p.booking_type,
        amount_minor_units: p.amount_minor_units,
        currency: p.currency,
        ...(p.booking_type === "half_day" ? { half_day_duration_hours: p.half_day_duration_hours ?? null } : {}),
      })),
    bookable_options: summary.price_on_request
      ? requestableOptions(location_pricing)
      : active
          .filter((p) => p.amount_minor_units > 0)
          .map((p) => ({
            type: p.booking_type,
            ...(p.booking_type === "half_day" ? { half_day_duration_hours: p.half_day_duration_hours ?? null } : {}),
          })),
  };
}

/**
 * The id/host of a listing if `supabase` (the caller's own client) may see it, else null. RLS on
 * the caller's client is what decides visibility; this reads only columns every role can read.
 */
async function visibleRow(supabase: SupabaseClient, id: string): Promise<{ id: string; host_id: string } | null> {
  const { data, error } = await supabase.from("locations").select("id, host_id").eq("id", id).maybeSingle();
  if (error) {
    throw error;
  }
  return (data as { id: string; host_id: string } | null) ?? null;
}

async function fetchHostPublicSummary(supabase: SupabaseClient, hostId: string): Promise<HostPublicSummary | null> {
  const { data, error } = await supabase.rpc("get_host_public_profile", { _host_id: hostId }).maybeSingle();
  if (error) {
    throw error;
  }
  return (data as HostPublicSummary | null) ?? null;
}

/**
 * The full row -- including the private address columns -- of a listing the caller can see, or
 * null. For server-side decisions (ownership, bookability); a response to a non-owner must go
 * through `forViewer` first.
 */
export async function getVisibleLocationOrNull(supabase: SupabaseClient, id: string): Promise<LocationSummary | null> {
  if (!(await visibleRow(supabase, id))) {
    return null;
  }
  const { data, error } = await adminClient.from("locations").select(LOCATION_COLUMNS).eq("id", id).maybeSingle();
  if (error) {
    throw error;
  }
  return (data as LocationSummary | null) ?? null;
}

/**
 * Shared ownership/visibility gate reused by every module that manages a
 * sub-resource of a location (media, availability, ...): invisible location
 * -> 404 (don't reveal a private draft exists), visible but not owned and
 * caller isn't admin -> 403.
 */
export async function assertLocationManageable(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string
): Promise<LocationSummary> {
  const location = await getVisibleLocationOrNull(supabase, locationId);
  if (!location) {
    throw new NotFoundError("Location not found.");
  }
  if (location.host_id !== callerId && !isAdmin) {
    throw new ForbiddenError("You do not have permission to manage this location.");
  }
  return location;
}

export async function getLocation(supabase: SupabaseClient, id: string, viewer: LocationViewer = PUBLIC_VIEWER): Promise<LocationDetail> {
  // Phase 29.6: `media` on a location detail is the GENERAL gallery only. The embedded filter is
  // what keeps a section's photos out of it -- without it every section photo would be flattened
  // into `media`, and `flattenDetail`'s position sort would happily put a section photo at the
  // front as the location's cover. Section galleries are fetched per section.
  //
  // Visibility is decided by the caller's own client (RLS); the row and its children are then read
  // with the service role, because the address columns aren't readable by anyone else. The child
  // tables gate on exactly the same condition as the parent row, so nothing becomes visible that
  // the caller couldn't already read -- except a price-on-request listing's pricing rows, which
  // flattenDetail hides again for anyone but the host and the team.
  if (!(await visibleRow(supabase, id))) {
    throw new NotFoundError("Location not found.");
  }
  const { data, error } = await adminClient
    .from("locations")
    .select(LOCATION_DETAIL_SELECT)
    .eq("id", id)
    .is("location_media.section_id", null)
    .single();

  if (error || !data) {
    throw new NotFoundError("Location not found.");
  }

  const row = data as unknown as RawLocationDetailRow;
  const host = await fetchHostPublicSummary(supabase, row.host_id);
  return flattenDetail(row, host, viewer);
}

export interface PaginatedLocations {
  data: LocationSummary[];
  total: number;
}

export interface LocationListFilters {
  status?: string;
  hostId?: string;
  search?: string;
}

async function listLocations(
  supabase: SupabaseClient,
  page: number,
  pageSize: number,
  filters: LocationListFilters = {},
  // Phase 29.18-H: the columns this listing returns. Defaults to LOCATION_COLUMNS,
  // so GET /v1/admin/locations -- the other caller -- is byte-for-byte unchanged.
  // Only listMyLocations() passes anything else. Paging, ordering and filtering
  // stay in this one function so the two listings cannot drift apart.
  select: string = LOCATION_COLUMNS
): Promise<PaginatedLocations> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  // Two steps since the address columns became service-role-only: the caller's own client picks the
  // page (RLS decides which rows it may list), then the service role reads those rows in full.
  let query = supabase.from("locations").select("id", { count: "exact" });

  if (filters.status) {
    query = query.eq("status", filters.status);
  }
  if (filters.hostId) {
    query = query.eq("host_id", filters.hostId);
  }
  if (filters.search) {
    // The title, or the listing ID (HKLS07). The ID column is service-role only, so matching IDs are
    // looked up with the service role first and fed to the caller's own query as plain ids.
    const term = filters.search.replace(/[,()%*\\]/g, " ").trim();
    const { data: byCode, error: codeError } = await adminClient
      .from("locations")
      .select("id")
      .ilike("listing_code", `%${term}%`)
      .limit(200);
    if (codeError) {
      throw codeError;
    }
    const codeIds = ((byCode ?? []) as { id: string }[]).map((r) => r.id);
    query =
      codeIds.length > 0
        ? query.or(`title.ilike.%${term}%,id.in.(${codeIds.join(",")})`)
        : query.ilike("title", `%${filters.search}%`);
  }

  const { data, error, count } = await query.order("created_at", { ascending: false }).range(from, to);

  if (error) {
    throw error;
  }
  const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) {
    return { data: [], total: count ?? 0 };
  }
  const { data: rows, error: rowsError } = await adminClient.from("locations").select(select).in("id", ids);
  if (rowsError) {
    throw rowsError;
  }
  const byId = new Map(((rows ?? []) as unknown as LocationSummary[]).map((r) => [r.id, r]));
  return {
    data: ids.map((id) => byId.get(id)).filter((r): r is LocationSummary => Boolean(r)),
    total: count ?? 0,
  };
}

// ============================================================================
// Phase 29.18-H / 29.18-J — GET /v1/me/locations carries what a listing row needs
// ============================================================================
//
// WHY THIS EXISTS
//
// Host "My Listings" renders a cover photo and a starting price per row, but
// this listing returned LOCATION_COLUMNS only -- no media, no pricing. Every
// row therefore showed a placeholder image and no price (29.18-G, defect D-1),
// and because the iOS completeness check needs both, a *complete* backend
// `draft` was also mis-badged on the list while the detail badged it correctly
// (D-2). 29.18-H added media and pricing, which fixed D-1.
//
// Phase 29.18-J adds CATEGORIES, which closes D-2. 29.18-I measured the
// residual: iOS's `isBackendBasicsValid` also requires at least one category,
// so with media and pricing present but categories absent the list still could
// not tell a complete draft from an incomplete one, and stayed conservatively
// on "Draft" while the detail said "Ready". With all three embedded, a row now
// carries everything that rule reads.
//
// The backend deliberately does NOT compute completeness. That rule is the
// client's (it is stricter than the backend's own REQUIRED_FOR_SUBMISSION,
// which does not require a category at all), and duplicating it here would
// create a second copy to drift. This only supplies the source data.
//
// There is no batch-media / batch-pricing / batch-categories-by-location-ids
// route, so a client fetching any of them per row would be a literal N+1 --
// the same reasoning, and the same solution, as Phase 29.14-B's nested embed on
// BOOKING_DETAIL_SELECT. One request still answers one page.
//
// NO RLS CHANGE WAS NEEDED OR MADE. `location_media_select_via_location`,
// `location_pricing_select_via_location` and the `location_categories` SELECT
// policy all gate their rows on exactly the condition `locations` is gated on
// (published, or own, or admin). Since this listing is already filtered to
// `host_id = <caller>`, the embeds can only ever return children of rows the
// caller could already read. No new grant, no new policy, no new endpoint, no
// migration.
const HOST_LOCATION_LIST_SELECT = `
  ${LOCATION_COLUMNS},
  location_media ( id, media_type, storage_key, position, section_id, created_at, updated_at ),
  location_pricing ( booking_type, amount_minor_units, currency, is_active, half_day_duration_hours ),
  location_categories ( categories ( id, name ) )
`;

/** One embedded `location_media` row, exactly as the select above returns it. */
interface RawListMediaRow extends RawLocationMediaRow {
  section_id: string | null;
}

interface RawHostLocationRow extends LocationSummary {
  location_media: RawListMediaRow[] | null;
  location_pricing: RawLocationPricingRow[] | null;
  // Same two-level join shape `LOCATION_DETAIL_SELECT` produces, so the same
  // flattening applies. A row whose join target is missing yields `null` here.
  location_categories: { categories: CatalogRef | null }[] | null;
}

/**
 * One active pricing row as a My Listings row reports it.
 *
 * `type` (not `booking_type`) is deliberate: it is the name `booking_options`
 * already uses on `GET /v1/locations/:id`, so the list and the detail carry the
 * same shape and a client needs one decoder, not two. `is_active` is included
 * for symmetry with the pricing management endpoint and is **always `true`
 * here** -- inactive rows are filtered out below, because an inactive tier
 * cannot be booked and must never become a row's starting price.
 */
export interface HostBookingOption extends BookingOption {
  is_active: boolean;
}

/**
 * A My Listings row: the summary, plus the general gallery, active pricing and
 * the listing's categories.
 *
 * `categories` is `CatalogRef[]` — the **same** `{id, name}` shape
 * `GET /v1/locations/:id` has always returned, produced by the same embed and
 * flattened the same way. No new category representation was introduced.
 */
export interface HostLocationSummary extends LocationSummary {
  media: PublicMediaItem[];
  booking_options: HostBookingOption[];
  categories: CatalogRef[];
}

/**
 * Reduces one embedded row to the shape the API returns.
 *
 * The raw rows never leave this module. `toPublicMediaItem` is the same mapper
 * `flattenDetail` uses, so `storage_key` -- an internal R2 detail -- is dropped
 * here exactly as it is everywhere else, and `media` on a list row is the same
 * shape as `media` on the detail.
 */
function toHostLocationSummary(row: RawHostLocationRow): HostLocationSummary {
  const { location_media, location_pricing, location_categories, ...summary } = row;

  // THE GENERAL GALLERY ONLY. A section photo must never reach this array: the
  // cover is the lowest-positioned photo, so a section photo landing here could
  // silently become the listing's cover -- the precise bug `getLocation`
  // filters `location_media.section_id IS NULL` to prevent.
  //
  // Filtered here in TypeScript rather than as a PostgREST embedded filter,
  // which is what Phase 29.14-B does with the identical embed (see
  // `primaryMediaUrlFor`): the embed is selected raw and reduced in code. That
  // keeps `listLocations` a single generic paging function shared with the
  // admin listing, and keeps the rule that decides a cover photo in plain,
  // directly testable code rather than in a query string.
  const general = (location_media ?? []).filter((m) => m.section_id === null);

  return {
    ...(summary as LocationSummary),
    media: general.map(toPublicMediaItem).sort((a, b) => a.position - b.position),
    // Active pricing only -- filtered the same way, and for the same reason,
    // that `flattenDetail` filters `booking_options`.
    booking_options: (location_pricing ?? [])
      .filter((p) => p.is_active)
      .map((p) => ({
        type: p.booking_type,
        amount_minor_units: p.amount_minor_units,
        currency: p.currency,
        ...(p.booking_type === "half_day" ? { half_day_duration_hours: p.half_day_duration_hours ?? null } : {}),
        is_active: p.is_active,
      })),
    // Flattened exactly as `flattenDetail` flattens the identical embed. The
    // null guard is not decoration: the join row is what the embed returns, and
    // a join row whose target is missing would otherwise put a literal `null`
    // into an array typed `CatalogRef[]` — a client counting categories to
    // decide completeness would then count a category that does not exist.
    categories: (location_categories ?? [])
      .map((r) => r.categories)
      .filter((c): c is CatalogRef => c !== null),
  };
}

export interface PaginatedHostLocations {
  data: HostLocationSummary[];
  total: number;
}

export async function listMyLocations(
  supabase: SupabaseClient,
  hostId: string,
  page: number,
  pageSize: number
): Promise<PaginatedHostLocations> {
  const { data, total } = await listLocations(
    supabase,
    page,
    pageSize,
    { hostId },
    HOST_LOCATION_LIST_SELECT
  );
  return { data: (data as unknown as RawHostLocationRow[]).map(toHostLocationSummary), total };
}

/** Admin Console 2: an admin listing row also carries what the Locations table shows. */
export interface AdminLocationSummary extends LocationSummary {
  /** The general gallery's first photo -- the listing's cover -- or null when it has none yet. */
  cover_url: string | null;
  media_count: number;
  host: { id: string; first_name: string | null; last_name: string | null } | null;
  /** Lowest ACTIVE price across booking types, for the table's "from" column. */
  starting_price: { amount_minor_units: number; currency: string; booking_type: string } | null;
}

export interface PaginatedAdminLocations {
  data: AdminLocationSummary[];
  total: number;
}

export async function listAllLocationsForAdmin(
  supabase: SupabaseClient,
  page: number,
  pageSize: number,
  filters: LocationListFilters = {}
): Promise<PaginatedAdminLocations> {
  const { data, total } = await listLocations(supabase, page, pageSize, filters);
  if (data.length === 0) {
    return { data: [], total };
  }

  const ids = data.map((l) => l.id);
  const hostIds = [...new Set(data.map((l) => l.host_id))];

  // Three small batched reads for the whole page rather than one per row. They use the
  // service-role client only because the caller has already passed requirePermission
  // ("locations.view") on this route -- the rows being enriched are the ones RLS just returned.
  const [mediaResult, hostResult, pricingResult] = await Promise.all([
    adminClient
      .from("location_media")
      .select("location_id, storage_key, media_type, position, section_id")
      .in("location_id", ids)
      .order("position", { ascending: true }),
    adminClient.from("profiles").select("id, first_name, last_name").in("id", hostIds),
    adminClient
      .from("location_pricing")
      .select("location_id, booking_type, amount_minor_units, currency, is_active")
      .in("location_id", ids)
      .eq("is_active", true),
  ]);
  for (const result of [mediaResult, hostResult, pricingResult]) {
    if (result.error) {
      throw result.error;
    }
  }

  const media = (mediaResult.data ?? []) as {
    location_id: string;
    storage_key: string;
    media_type: string;
    position: number;
    section_id: string | null;
  }[];
  const hosts = new Map(
    ((hostResult.data ?? []) as { id: string; first_name: string | null; last_name: string | null }[]).map((h) => [h.id, h])
  );
  const pricing = (pricingResult.data ?? []) as {
    location_id: string;
    booking_type: string;
    amount_minor_units: number;
    currency: string;
  }[];

  return {
    total,
    data: data.map((location) => {
      const own = media.filter((m) => m.location_id === location.id);
      const cover = own.find((m) => m.section_id === null && m.media_type === "photo") ?? own.find((m) => m.media_type === "photo");
      const prices = pricing
        .filter((p) => p.location_id === location.id)
        .sort((a, b) => a.amount_minor_units - b.amount_minor_units);
      return {
        ...location,
        cover_url: cover ? publicUrlFor(cover.storage_key) : null,
        media_count: own.length,
        host: hosts.get(location.host_id) ?? null,
        starting_price: prices[0]
          ? { amount_minor_units: prices[0].amount_minor_units, currency: prices[0].currency, booking_type: prices[0].booking_type }
          : null,
      };
    }),
  };
}

async function replaceTags(
  supabase: SupabaseClient,
  locationId: string,
  table: string,
  column: string,
  ids: string[]
): Promise<void> {
  const { error: deleteError } = await supabase.from(table).delete().eq("location_id", locationId);
  if (deleteError) {
    throw deleteError;
  }

  if (ids.length === 0) {
    return;
  }

  const rows = ids.map((id) => ({ location_id: locationId, [column]: id }));
  const { error: insertError } = await supabase.from(table).insert(rows);
  if (insertError) {
    if (insertError.code === FOREIGN_KEY_VIOLATION) {
      throw new ValidationError("One or more category/amenity/use-case IDs do not exist.");
    }
    throw insertError;
  }
}

export async function createLocation(
  supabase: SupabaseClient,
  hostId: string,
  // `listing_code` is only ever passed by the team (with the service-role client); hosts get the next
  // automatic ID from the database.
  input: CreateLocationInput & { listing_code?: string }
): Promise<LocationDetail> {
  const { category_ids, amenity_ids, use_case_ids, ...fields } = input;

  const { data: createdRow, error } = await supabase
    .from("locations")
    .insert({ ...fields, host_id: hostId })
    .select("id")
    .single();

  if (error || !createdRow) {
    if (error?.code === UNIQUE_VIOLATION) {
      throw new ConflictError(`The ID ${input.listing_code ?? ""} is already used by another listing.`.replace("  ", " "));
    }
    throw error ?? new Error("Failed to create location.");
  }

  const locationId = (createdRow as LocationSummary).id;

  await replaceTags(supabase, locationId, "location_categories", "category_id", category_ids);
  await replaceTags(supabase, locationId, "location_amenities", "amenity_id", amenity_ids);
  await replaceTags(supabase, locationId, "location_use_cases", "use_case_id", use_case_ids);

  return getLocation(supabase, locationId, { userId: hostId, isAdmin: false });
}

export async function updateLocation(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string,
  input: UpdateLocationInput,
  auditReason: string | null = null
): Promise<LocationDetail> {
  const current = await getVisibleLocationOrNull(supabase, locationId);
  if (!current) {
    throw new NotFoundError("Location not found.");
  }
  if (current.host_id !== callerId && !isAdmin) {
    throw new ForbiddenError("You do not have permission to modify this location.");
  }

  const {
    category_ids,
    amenity_ids,
    use_case_ids,
    status,
    show_exact_location: showExact,
    listing_code: listingCode,
    ...fields
  } = input as UpdateLocationInput & { show_exact_location?: boolean };

  // The listing ID is the team's: a host can see it but never change it.
  if (listingCode !== undefined && !isAdmin) {
    throw new ForbiddenError("Only the team can change a listing's ID.");
  }

  // Whether the full address and pin show before booking is the team's decision, never the host's.
  if (showExact !== undefined && !isAdmin) {
    throw new ForbiddenError("Only the team can choose to show this listing's exact location.");
  }

  if (status !== undefined && !isAdmin) {
    const allowed = HOST_ALLOWED_TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(status)) {
      throw new ForbiddenError(`Hosts cannot change status from '${current.status}' to '${status}'.`);
    }
    if (status === "submitted") {
      const merged = { ...current, ...fields };
      const missing = REQUIRED_FOR_SUBMISSION.filter((key) => {
        const value = merged[key];
        return value === null || value === undefined || value === "";
      });
      if (missing.length > 0) {
        throw new ValidationError(`Cannot submit for review — missing: ${missing.join(", ")}.`);
      }
    }
  }

  // `locations` no longer grants authenticated UPDATE on status at all
  // (Phase 12: a host could otherwise self-publish or self-restore via
  // direct PostgREST, bypassing HOST_ALLOWED_TRANSITIONS/admin moderation
  // entirely). Ordinary content fields are unaffected -- host-owns-row is
  // still fully enforced above, and via RLS -- only status now requires the
  // service-role client. Two separate statements because a single UPDATE
  // naming any column the caller's own client isn't granted would fail in
  // full, even for the columns it IS allowed to touch.
  if (Object.keys(fields).length > 0) {
    const { error } = await supabase.from("locations").update(fields).eq("id", locationId);
    if (error) {
      throw error;
    }
  }

  if (showExact !== undefined && showExact !== current.show_exact_location) {
    const { error } = await adminClient.from("locations").update({ show_exact_location: showExact }).eq("id", locationId);
    if (error) {
      throw error;
    }
  }

  if (listingCode !== undefined && listingCode !== current.listing_code) {
    const { error } = await adminClient.from("locations").update({ listing_code: listingCode }).eq("id", locationId);
    if (error) {
      if (error.code === UNIQUE_VIOLATION) {
        throw new ConflictError(`The ID ${listingCode} is already used by another listing.`);
      }
      throw error;
    }
  }

  if (status !== undefined) {
    const { error } = await adminClient.from("locations").update({ status }).eq("id", locationId);
    if (error) {
      throw error;
    }
    if (isAdmin) {
      // Only the four purpose-built moderation actions (approve/reject/
      // suspend/restore, admin/locations.service.ts) map cleanly onto their
      // own documented audit action -- this generic path can reach ANY of
      // the 8 statuses (including 'approved'/'under_review', which no
      // dedicated endpoint produces), so it gets its own, equally-audited
      // action rather than being force-fit into one of the other four.
      await writeAuditLog(callerId, "ADMIN_UPDATED_LOCATION_STATUS", "location", locationId, null, {
        previous_status: current.status,
        new_status: status,
      });
    }
  }

  if (category_ids !== undefined) {
    await replaceTags(supabase, locationId, "location_categories", "category_id", category_ids);
  }
  if (amenity_ids !== undefined) {
    await replaceTags(supabase, locationId, "location_amenities", "amenity_id", amenity_ids);
  }
  if (use_case_ids !== undefined) {
    await replaceTags(supabase, locationId, "location_use_cases", "use_case_id", use_case_ids);
  }

  // Admin Console: content edits (not just status) an admin makes to someone else's listing are
  // audited too -- which fields, never their values (a description can be long; the listing itself
  // is the record of what it now says).
  const changedFields = [
    ...Object.keys(fields),
    ...(showExact !== undefined && showExact !== current.show_exact_location ? ["show_exact_location"] : []),
    ...(listingCode !== undefined && listingCode !== current.listing_code ? ["listing_code"] : []),
    ...(category_ids !== undefined ? ["category_ids"] : []),
    ...(amenity_ids !== undefined ? ["amenity_ids"] : []),
    ...(use_case_ids !== undefined ? ["use_case_ids"] : []),
  ];
  if (isAdmin && current.host_id !== callerId && changedFields.length > 0) {
    await writeAuditLog(callerId, "ADMIN_UPDATED_LOCATION", "location", locationId, auditReason, { fields: changedFields });
  }

  return getLocation(supabase, locationId, { userId: callerId, isAdmin });
}

export async function deleteLocation(
  supabase: SupabaseClient,
  callerId: string,
  isAdmin: boolean,
  locationId: string
): Promise<void> {
  const current = await getVisibleLocationOrNull(supabase, locationId);
  if (!current) {
    throw new NotFoundError("Location not found.");
  }
  if (current.host_id !== callerId && !isAdmin) {
    throw new ForbiddenError("You do not have permission to delete this location.");
  }

  const { error } = await supabase.from("locations").delete().eq("id", locationId);
  if (error) {
    // bookings.location_id deliberately has no ON DELETE CASCADE — a
    // location with any booking history can't be deleted out from under it.
    if (error.code === FOREIGN_KEY_VIOLATION) {
      throw new ConflictError("Cannot delete a location with existing bookings.");
    }
    throw error;
  }
}

/** Admin Console 2: the compact card a catalog item or collection shows for each listing in it. */
export interface LocationCard {
  id: string;
  title: string;
  city: string;
  region: string | null;
  country: string;
  area: string | null;
  price_on_request: boolean;
  status: string;
  host_id: string;
  cover_url: string | null;
  starting_price: { amount_minor_units: number; currency: string; booking_type: string } | null;
}

/**
 * Cards for `ids`, in the order given (ids that no longer exist are dropped). `client` decides
 * visibility: pass the service-role client for admin views, the caller's client for public ones --
 * RLS then hides unpublished listings and their photos exactly as it does everywhere else.
 */
export async function getLocationCards(client: SupabaseClient, ids: string[]): Promise<LocationCard[]> {
  if (ids.length === 0) {
    return [];
  }
  const [locationsResult, mediaResult, pricingResult] = await Promise.all([
    client.from("locations").select("id, title, city, region, country, area, price_on_request, status, host_id").in("id", ids),
    client
      .from("location_media")
      .select("location_id, storage_key, media_type, position, section_id")
      .in("location_id", ids)
      .eq("media_type", "photo")
      .order("position", { ascending: true }),
    client
      .from("location_pricing")
      .select("location_id, booking_type, amount_minor_units, currency")
      .in("location_id", ids)
      .eq("is_active", true),
  ]);
  for (const result of [locationsResult, mediaResult, pricingResult]) {
    if (result.error) {
      throw result.error;
    }
  }
  const media = (mediaResult.data ?? []) as { location_id: string; storage_key: string; section_id: string | null }[];
  const pricing = (pricingResult.data ?? []) as {
    location_id: string;
    booking_type: string;
    amount_minor_units: number;
    currency: string;
  }[];
  const byId = new Map(
    ((locationsResult.data ?? []) as Omit<LocationCard, "cover_url" | "starting_price">[]).map((l) => [l.id, l])
  );

  return ids
    .map((id) => byId.get(id))
    .filter((l): l is Omit<LocationCard, "cover_url" | "starting_price"> => Boolean(l))
    .map((l) => {
      const own = media.filter((m) => m.location_id === l.id);
      const cover = own.find((m) => m.section_id === null) ?? own[0];
      // A price-on-request listing has no public price.
      const cheapest = l.price_on_request
        ? undefined
        : pricing
            .filter((p) => p.location_id === l.id && p.amount_minor_units > 0)
            .sort((a, b) => a.amount_minor_units - b.amount_minor_units)[0];
      return {
        ...l,
        cover_url: cover ? publicUrlFor(cover.storage_key) : null,
        starting_price: cheapest
          ? { amount_minor_units: cheapest.amount_minor_units, currency: cheapest.currency, booking_type: cheapest.booking_type }
          : null,
      };
    });
}

import { SupabaseClient } from "@supabase/supabase-js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { publicUrlFor } from "../../lib/r2";
import { writeAuditLog } from "../admin/audit.service";
import { CreateLocationInput, UpdateLocationInput } from "./locations.schema";

const FOREIGN_KEY_VIOLATION = "23503";

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
const LOCATION_COLUMNS = `
  id, host_id, title, description,
  address_line1, address_line2, city, region, country, postal_code,
  latitude, longitude, capacity, timezone, instant_booking_enabled,
  status, moderation_reason, suspended_by_host_suspension, created_at, updated_at
`;

const LOCATION_DETAIL_SELECT = `
  ${LOCATION_COLUMNS},
  location_categories ( categories ( id, name ) ),
  location_amenities ( amenities ( id, name ) ),
  location_use_cases ( use_cases ( id, name ) ),
  location_media ( id, media_type, storage_key, position, metadata, created_at, updated_at ),
  location_pricing ( booking_type, amount_minor_units, currency, is_active )
`;

// A host may only request these transitions through the general-purpose
// PATCH endpoint; anything else from a non-admin caller is 403. Admins may
// set any of the 8 statuses. Kept deliberately small — a full workflow
// engine is explicitly a later-phase concern.
const HOST_ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ["submitted"],
  submitted: ["draft"],
  published: ["archived"],
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
  capacity: number | null;
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
}

interface RawLocationPricingRow {
  booking_type: string;
  amount_minor_units: number;
  currency: string;
  is_active: boolean;
}

export interface LocationDetail extends LocationSummary {
  categories: CatalogRef[];
  amenities: CatalogRef[];
  use_cases: CatalogRef[];
  media: PublicMediaItem[];
  host: HostPublicSummary | null;
  booking_options: BookingOption[];
}

interface RawLocationDetailRow extends LocationSummary {
  location_categories: { categories: CatalogRef }[];
  location_amenities: { amenities: CatalogRef }[];
  location_use_cases: { use_cases: CatalogRef }[];
  location_media: RawLocationMediaRow[];
  location_pricing: RawLocationPricingRow[];
}

function flattenDetail(row: RawLocationDetailRow, host: HostPublicSummary | null): LocationDetail {
  const { location_categories, location_amenities, location_use_cases, location_media, location_pricing, ...summary } =
    row as RawLocationDetailRow;
  return {
    ...(summary as LocationSummary),
    categories: location_categories.map((r) => r.categories),
    amenities: location_amenities.map((r) => r.amenities),
    use_cases: location_use_cases.map((r) => r.use_cases),
    media: location_media.map(toPublicMediaItem).sort((a, b) => a.position - b.position),
    host,
    // Active pricing only — booking_options is a marketplace/booking-facing
    // field, not a management one, so it's filtered the same way regardless
    // of who's viewing (the owner/admin management view of inactive pricing
    // configs lives at GET /v1/locations/:id/pricing, not here).
    booking_options: location_pricing
      .filter((p) => p.is_active)
      .map((p) => ({ type: p.booking_type, amount_minor_units: p.amount_minor_units, currency: p.currency })),
  };
}

async function fetchHostPublicSummary(supabase: SupabaseClient, hostId: string): Promise<HostPublicSummary | null> {
  const { data, error } = await supabase.rpc("get_host_public_profile", { _host_id: hostId }).maybeSingle();
  if (error) {
    throw error;
  }
  return (data as HostPublicSummary | null) ?? null;
}

export async function getVisibleLocationOrNull(supabase: SupabaseClient, id: string): Promise<LocationSummary | null> {
  const { data, error } = await supabase.from("locations").select(LOCATION_COLUMNS).eq("id", id).maybeSingle();
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

export async function getLocation(supabase: SupabaseClient, id: string): Promise<LocationDetail> {
  // Phase 29.6: `media` on a location detail is the GENERAL gallery only. The embedded filter is
  // what keeps a section's photos out of it -- without it every section photo would be flattened
  // into `media`, and `flattenDetail`'s position sort would happily put a section photo at the
  // front as the location's cover. Section galleries are fetched per section.
  const { data, error } = await supabase
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
  return flattenDetail(row, host);
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

  let query = supabase.from("locations").select(select, { count: "exact" });

  if (filters.status) {
    query = query.eq("status", filters.status);
  }
  if (filters.hostId) {
    query = query.eq("host_id", filters.hostId);
  }
  if (filters.search) {
    query = query.ilike("title", `%${filters.search}%`);
  }

  const { data, error, count } = await query.order("created_at", { ascending: false }).range(from, to);

  if (error) {
    throw error;
  }

  return { data: (data as unknown as LocationSummary[]) ?? [], total: count ?? 0 };
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
  location_pricing ( booking_type, amount_minor_units, currency, is_active ),
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

export function listAllLocationsForAdmin(
  supabase: SupabaseClient,
  page: number,
  pageSize: number,
  filters: LocationListFilters = {}
): Promise<PaginatedLocations> {
  return listLocations(supabase, page, pageSize, filters);
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
  input: CreateLocationInput
): Promise<LocationDetail> {
  const { category_ids, amenity_ids, use_case_ids, ...fields } = input;

  const { data: createdRow, error } = await supabase
    .from("locations")
    .insert({ ...fields, host_id: hostId })
    .select(LOCATION_COLUMNS)
    .single();

  if (error || !createdRow) {
    throw error ?? new Error("Failed to create location.");
  }

  const locationId = (createdRow as LocationSummary).id;

  await replaceTags(supabase, locationId, "location_categories", "category_id", category_ids);
  await replaceTags(supabase, locationId, "location_amenities", "amenity_id", amenity_ids);
  await replaceTags(supabase, locationId, "location_use_cases", "use_case_id", use_case_ids);

  return getLocation(supabase, locationId);
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

  const { category_ids, amenity_ids, use_case_ids, status, ...fields } = input;

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
    ...(category_ids !== undefined ? ["category_ids"] : []),
    ...(amenity_ids !== undefined ? ["amenity_ids"] : []),
    ...(use_case_ids !== undefined ? ["use_case_ids"] : []),
  ];
  if (isAdmin && current.host_id !== callerId && changedFields.length > 0) {
    await writeAuditLog(callerId, "ADMIN_UPDATED_LOCATION", "location", locationId, auditReason, { fields: changedFields });
  }

  return getLocation(supabase, locationId);
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

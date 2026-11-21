import { anonClient } from "../../lib/supabase";
import { publicUrlFor } from "../../lib/r2";
import { APPROXIMATE_RADIUS_M, CatalogRef } from "../locations/locations.service";
import { SearchLocationsQuery } from "./search.schema";

/**
 * The cheapest way to start booking a location, summarised for a discovery card
 * (Phase 29 D1).
 *
 * Chosen by `search_locations()` in Postgres, never here: among active pricing
 * rows with a positive amount, the cheapest amount wins when the location uses a
 * single currency, and a deterministic unit order (hourly -> half_day -> day ->
 * multi_day) decides otherwise — including when a location mixes currencies,
 * where comparing minor units would be meaningless. Keeping the rule in one
 * place is the point: web and Android inherit the same answer.
 *
 * Deliberately carries no formatted string, symbol or unit label. Clients own
 * localisation; `booking_type` is the same enum `booking_options` already
 * returns on location detail.
 *
 * A summary of configured pricing — never a quote. The booking flow remains
 * authoritative for what anything actually costs.
 */
export interface StartingPrice {
  amount_minor_units: number;
  currency: string;
  booking_type: "hourly" | "half_day" | "day" | "multi_day";
}

interface SearchLocationRow {
  id: string;
  title: string;
  excerpt: string;
  city: string;
  region: string | null;
  country: string;
  area: string | null;
  latitude: number | null;
  longitude: number | null;
  exact_location: boolean;
  capacity: number | null;
  area_sqft: number | null;
  set_count: number | null;
  parking_spaces: number | null;
  restroom_count: number | null;
  electricity: "included" | "extra" | "not_available" | null;
  permission_needed: boolean | null;
  props_count: number | null;
  distance_km: number | null;
  categories: CatalogRef[];
  use_cases: CatalogRef[];
  primary_media_key: string | null;
  starting_price: StartingPrice | null;
  price_on_request: boolean;
  created_at: string;
  total_count: number;
}

export interface SearchLocationCard {
  id: string;
  title: string;
  excerpt: string;
  city: string;
  region: string | null;
  country: string;
  area: string | null;
  /**
   * The point a map may show: APPROXIMATE (up to ~1.4 km off, draw a circle of
   * `approximate_radius_m`) unless `location_precision` is "exact" -- the team marked the listing
   * "show exact location". Search never returns a real pin otherwise, to anyone.
   */
  latitude: number | null;
  longitude: number | null;
  location_precision: "exact" | "approximate";
  approximate_radius_m: number | null;
  capacity: number | null;
  /** Quick facts for the card. Each is null when the host hasn't said. */
  area_sqft: number | null;
  set_count: number | null;
  parking_spaces: number | null;
  restroom_count: number | null;
  electricity: "included" | "extra" | "not_available" | null;
  permission_needed: boolean | null;
  props_count: number;
  categories: CatalogRef[];
  use_cases: CatalogRef[];
  primary_media_url: string | null;
  /** Null for a price-on-request listing. */
  starting_price: StartingPrice | null;
  price_on_request: boolean;
  created_at: string;
  distance_km?: number;
}

export interface SearchResult {
  data: SearchLocationCard[];
  total: number;
}

function toCard(row: SearchLocationRow): SearchLocationCard {
  return {
    id: row.id,
    title: row.title,
    excerpt: row.excerpt,
    city: row.city,
    region: row.region,
    country: row.country,
    area: row.area ?? null,
    latitude: row.latitude,
    longitude: row.longitude,
    location_precision: row.exact_location ? "exact" : "approximate",
    approximate_radius_m: row.exact_location ? null : APPROXIMATE_RADIUS_M,
    capacity: row.capacity,
    area_sqft: row.area_sqft ?? null,
    set_count: row.set_count ?? null,
    parking_spaces: row.parking_spaces ?? null,
    restroom_count: row.restroom_count ?? null,
    electricity: row.electricity ?? null,
    permission_needed: row.permission_needed ?? null,
    props_count: row.props_count ?? 0,
    categories: row.categories,
    use_cases: row.use_cases,
    primary_media_url: row.primary_media_key ? publicUrlFor(row.primary_media_key) : null,
    // Passed through untouched — the database decided which tier this is, and
    // re-deriving or reformatting it here would create a second source of truth.
    starting_price: row.starting_price ?? null,
    price_on_request: row.price_on_request ?? false,
    created_at: row.created_at,
    ...(row.distance_km !== null ? { distance_km: row.distance_km } : {}),
  };
}

/** A city that has published listings, with the shoot types available there. */
export interface CityPage {
  city: string;
  listing_count: number;
  shoots: { id: string; name: string; listing_count: number }[];
}

/**
 * The cities (and the shoot types in each) that have published listings. The website builds its city
 * pages from this, and only for places that have something to show. "Mohali" and "Mohali, Punjab" are
 * one city (the database groups on the part before the first comma).
 */
export async function listCityPages(): Promise<CityPage[]> {
  const { data, error } = await anonClient.rpc("published_city_pages");
  if (error) {
    throw error;
  }
  return ((data ?? []) as { city: string; listing_count: number | string; shoots: CityPage["shoots"] }[]).map((row) => ({
    city: row.city,
    listing_count: Number(row.listing_count),
    shoots: (row.shoots ?? []).map((s) => ({ id: s.id, name: s.name, listing_count: Number(s.listing_count) })),
  }));
}

export async function searchLocations(query: SearchLocationsQuery): Promise<SearchResult> {
  const sort = query.sort ?? "relevant";

  const { data, error } = await anonClient.rpc("search_locations", {
    _search: query.search ?? null,
    _city: query.city ?? null,
    _region: query.region ?? null,
    _country: query.country ?? null,
    _category_ids: query.category_ids ?? null,
    _amenity_ids: query.amenity_ids ?? null,
    _use_case_ids: query.use_case_ids ?? null,
    _capacity_min: query.capacity_min ?? null,
    _capacity_max: query.capacity_max ?? null,
    _lat: query.lat ?? null,
    _lng: query.lng ?? null,
    _radius_km: query.radius_km ?? null,
    _north: query.north ?? null,
    _south: query.south ?? null,
    _east: query.east ?? null,
    _west: query.west ?? null,
    _sort: sort,
    _page: query.page,
    _page_size: query.pageSize,
    _price_min: query.price_min ?? null,
    _price_max: query.price_max ?? null,
    _parking_min: query.parking_min ?? null,
    _area_min: query.area_min ?? null,
    _restrooms_min: query.restrooms_min ?? null,
    _sets_min: query.sets_min ?? null,
    _electricity_included: query.electricity_included ?? null,
    _no_permission: query.no_permission ?? null,
    _has_props: query.has_props ?? null,
  });

  if (error) {
    throw error;
  }

  const rows = (data ?? []) as SearchLocationRow[];

  return {
    data: rows.map(toCard),
    total: rows.length > 0 ? rows[0]!.total_count : 0,
  };
}

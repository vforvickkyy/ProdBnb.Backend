import { adminClient } from "../../lib/supabase";

/**
 * Platform-wide settings (Admin Console) -- one row, `public.platform_settings`.
 *
 * Read on hot paths (every booking creation, every availability read, every payment creation),
 * so the row is cached in memory for a short TTL. Updating through `updatePlatformSettings()`
 * refreshes this instance's cache immediately; other warm Vercel instances pick the change up
 * within `CACHE_TTL_MS`. That window is acceptable for every consumer:
 *
 *  - fee/tax: a booking created a few seconds after an edit may still use the previous rate. Every
 *    booking stores its own price snapshot, so whichever rate applied is recorded truthfully.
 *  - unpaid-hold minutes: the pg_cron sweep reads the table directly, never this cache.
 */
export interface PlatformSettings {
  id: string;
  platform_fee_bps: number;
  tax_bps: number;
  unpaid_hold_minutes: number | null;
  /** Console 3: availability is shown to signed-in people only (GET /v1/locations/:id/availability). */
  availability_requires_login: boolean;
  /** Listing IDs: the letters in front (HKLS01), the minimum digits, and the number the next listing gets. */
  listing_id_prefix: string;
  listing_id_digits: number;
  listing_id_next: number;
  updated_by: string | null;
  updated_at: string;
}

const SETTINGS_COLUMNS =
  "id, platform_fee_bps, tax_bps, unpaid_hold_minutes, availability_requires_login, listing_id_prefix, listing_id_digits, listing_id_next, updated_by, updated_at";
const CACHE_TTL_MS = 30_000;

let cached: { value: PlatformSettings; at: number } | null = null;

/** The defaults the migration seeds -- also what a missing row means (never "fail the booking"). */
const DEFAULTS: Omit<PlatformSettings, "id" | "updated_at"> = {
  platform_fee_bps: 0,
  tax_bps: 0,
  unpaid_hold_minutes: null,
  availability_requires_login: true,
  listing_id_prefix: "HKLS",
  listing_id_digits: 2,
  listing_id_next: 1,
  updated_by: null,
};

export async function getPlatformSettings(options: { fresh?: boolean } = {}): Promise<PlatformSettings> {
  if (!options.fresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const { data, error } = await adminClient.from("platform_settings").select(SETTINGS_COLUMNS).eq("singleton", true).maybeSingle();
  if (error) {
    throw error;
  }

  const value: PlatformSettings = (data as PlatformSettings | null) ?? {
    id: "00000000-0000-0000-0000-000000000000",
    updated_at: new Date(0).toISOString(),
    ...DEFAULTS,
  };
  cached = { value, at: Date.now() };
  return value;
}

export interface PlatformSettingsPatch {
  platform_fee_bps?: number;
  tax_bps?: number;
  unpaid_hold_minutes?: number | null;
  availability_requires_login?: boolean;
  listing_id_prefix?: string;
  listing_id_digits?: number;
  listing_id_next?: number;
}

/** What a listing ID looks like for a given number, e.g. ("HKLS", 2, 7) -> "HKLS07". Mirrors next_listing_code() in the database. */
export function formatListingCode(prefix: string, digits: number, n: number): string {
  return `${prefix}${String(n).padStart(digits, "0")}`;
}

export async function updatePlatformSettings(actorId: string, patch: PlatformSettingsPatch): Promise<PlatformSettings> {
  const { data, error } = await adminClient
    .from("platform_settings")
    .update({ ...patch, updated_by: actorId })
    .eq("singleton", true)
    .select(SETTINGS_COLUMNS)
    .single();
  if (error || !data) {
    throw error ?? new Error("Failed to update platform settings.");
  }
  cached = { value: data as PlatformSettings, at: Date.now() };
  return data as PlatformSettings;
}

/** Tests only: forget the cached row so a test's own settings write is seen immediately. */
export function resetPlatformSettingsCacheForTesting(): void {
  cached = null;
}

/**
 * Platform fee and tax for a booking's base amount, in minor units.
 *
 * Integer basis points, rounded half-up once per component -- the same "minor units, never
 * floating point" rule every money column follows. Tax applies to base + fee, which is how a
 * service fee is normally taxed; with both rates at 0 (the default) this is the identity and every
 * booking prices exactly as it did before the Admin Console existed.
 */
export function platformCharges(
  baseMinorUnits: number,
  settings: Pick<PlatformSettings, "platform_fee_bps" | "tax_bps">
): { platform_fee_minor_units: number; tax_minor_units: number; total_amount_minor_units: number } {
  const fee = Math.round((baseMinorUnits * settings.platform_fee_bps) / 10_000);
  const tax = Math.round(((baseMinorUnits + fee) * settings.tax_bps) / 10_000);
  return { platform_fee_minor_units: fee, tax_minor_units: tax, total_amount_minor_units: baseMinorUnits + fee + tax };
}

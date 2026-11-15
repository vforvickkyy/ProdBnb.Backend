import { adminClient } from "../../lib/supabase";
import { getPlatformSettings } from "../platform/settings.service";

/**
 * Unpaid-hold expiry (Admin Console) -- the lazy, per-location half.
 *
 * The rule itself lives in one place, `public.expire_unpaid_bookings()` (migration
 * 20261115120000_unpaid_hold_expiry.sql); pg_cron runs it platform-wide every minute. This calls
 * the same function scoped to one location immediately before the backend computes availability or
 * creates a booking there, so a hold that lapsed 20 seconds ago can never make a slot look taken --
 * correctness does not depend on the cron's timing, or on pg_cron being available at all.
 *
 * Skipped entirely (no round trip) while expiry is off, which is the default.
 */
export async function expireUnpaidHolds(locationId?: string): Promise<string[]> {
  const settings = await getPlatformSettings();
  if (settings.unpaid_hold_minutes === null) {
    return [];
  }

  const { data, error } = await adminClient.rpc("expire_unpaid_bookings", locationId ? { _location_id: locationId } : {});
  if (error) {
    throw error;
  }
  return ((data ?? []) as unknown[]).map((row) => (typeof row === "string" ? row : String(Object.values(row as object)[0])));
}

/**
 * When an unpaid booking's hold lapses, or `null` when expiry is off. Informational only (the
 * Admin Console shows a countdown); the database function is the authority on what actually
 * expires, including the in-flight-checkout protection this does not model.
 */
export function holdDeadline(createdAt: string, holdMinutes: number | null): string | null {
  if (holdMinutes === null) {
    return null;
  }
  return new Date(new Date(createdAt).getTime() + holdMinutes * 60_000).toISOString();
}

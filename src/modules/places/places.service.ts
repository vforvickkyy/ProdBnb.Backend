import { AppError, NotFoundError, ServiceUnavailableError } from "../../errors/AppError";
import { getMapsServerKey } from "../site/integrations.service";

/**
 * Place search for the apps: the same Google results the website's "Where" field shows, asked
 * for by this backend with the Maps *server* key from Vault, so no key ships inside an app.
 *
 * Uses Places API (New): `places:autocomplete` for suggestions (India only, like the website),
 * then `places/{id}` for the chosen place's point and viewport. One session token covers a
 * search from first keystroke to the chosen place, which Google bills as a single session.
 */

const GOOGLE = "https://places.googleapis.com/v1";
const TIMEOUT_MS = 8000;

export interface PlaceSuggestion {
  id: string;
  /** "Bandra West" */
  main: string;
  /** "Mumbai, Maharashtra, India" */
  secondary: string;
}

export interface PlaceDetails {
  id: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  /** What the website searches inside when a place is picked. Null for a bare point. */
  viewport: { north: number; south: number; east: number; west: number } | null;
}

async function requireKey(): Promise<string> {
  const key = await getMapsServerKey();
  if (!key) {
    throw new ServiceUnavailableError("Place search isn't set up yet. Add a Google Maps server key in the admin console (Website → Google Maps).", {
      reason: "places_not_configured",
    });
  }
  return key;
}

async function callGoogle<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ServiceUnavailableError("Couldn't reach Google right now. Try again in a moment.", { reason: "places_unreachable" });
  }
  if (res.status === 404) throw new NotFoundError("That place wasn't found.");
  const body = (await res.json().catch(() => ({}))) as T & { error?: { status?: string; message?: string } };
  if (!res.ok) {
    // A key without Places API (New) enabled, or restricted to other APIs, lands here.
    console.error("Google Places answered", res.status, body.error?.status, body.error?.message);
    if (res.status === 400) throw new AppError(400, "VALIDATION_ERROR", "Google couldn't use that search.");
    throw new ServiceUnavailableError("Place search isn't working right now.", { reason: "places_failed", google_status: body.error?.status ?? null });
  }
  return body;
}

interface GoogleAutocomplete {
  suggestions?: {
    placePrediction?: {
      placeId: string;
      text?: { text?: string };
      structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
    };
  }[];
}

export async function autocompletePlaces(input: string, sessionToken?: string): Promise<PlaceSuggestion[]> {
  const key = await requireKey();
  const body = await callGoogle<GoogleAutocomplete>(`${GOOGLE}/places:autocomplete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
    body: JSON.stringify({
      input,
      includedRegionCodes: ["in"],
      languageCode: "en-IN",
      ...(sessionToken ? { sessionToken } : {}),
    }),
  });
  return (body.suggestions ?? [])
    .map((s) => s.placePrediction)
    .filter((p): p is NonNullable<typeof p> => Boolean(p?.placeId))
    .slice(0, 6)
    .map((p) => ({
      id: p.placeId,
      main: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
      secondary: p.structuredFormat?.secondaryText?.text ?? "",
    }))
    .filter((s) => s.main.length > 0);
}

interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  viewport?: { low?: { latitude?: number; longitude?: number }; high?: { latitude?: number; longitude?: number } };
}

export async function getPlaceDetails(placeId: string, sessionToken?: string): Promise<PlaceDetails> {
  const key = await requireKey();
  const url = new URL(`${GOOGLE}/places/${encodeURIComponent(placeId)}`);
  url.searchParams.set("languageCode", "en-IN");
  if (sessionToken) url.searchParams.set("sessionToken", sessionToken);
  const place = await callGoogle<GooglePlace>(url.toString(), {
    method: "GET",
    headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "id,displayName,formattedAddress,location,viewport" },
  });
  const lat = place.location?.latitude;
  const lng = place.location?.longitude;
  if (typeof lat !== "number" || typeof lng !== "number") throw new NotFoundError("That place has no position.");
  const low = place.viewport?.low;
  const high = place.viewport?.high;
  const viewport =
    low && high && [low.latitude, low.longitude, high.latitude, high.longitude].every((v) => typeof v === "number")
      ? { north: high.latitude!, south: low.latitude!, east: high.longitude!, west: low.longitude! }
      : null;
  return {
    id: place.id ?? placeId,
    name: place.displayName?.text ?? place.formattedAddress ?? "",
    address: place.formattedAddress ?? null,
    lat,
    lng,
    // A viewport that crosses the antimeridian can't be a search box; India never needs one.
    viewport: viewport && viewport.north > viewport.south && viewport.east > viewport.west ? viewport : null,
  };
}

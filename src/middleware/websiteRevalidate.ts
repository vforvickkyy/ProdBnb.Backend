import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";

const LOCATION_ID = /\/locations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;
const TIMEOUT_MS = 2500;

/** Tells the website to rebuild these listings' pages (and search) on their next visit. */
export async function revalidateWebsiteListings(locationIds: string[]): Promise<void> {
  if (!env.WEBSITE_REVALIDATE_URL || !env.WEBSITE_REVALIDATE_SECRET || locationIds.length === 0) return;
  try {
    const res = await fetch(env.WEBSITE_REVALIDATE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.WEBSITE_REVALIDATE_SECRET}` },
      body: JSON.stringify({ location_ids: locationIds }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) console.error(`Website refresh failed (${res.status}) for ${locationIds.join(", ")}`);
  } catch (err) {
    // Never fails the edit itself: the page still refreshes on its own timer.
    console.error("Website refresh failed:", err);
  }
}

/**
 * After any successful change to a listing -- PATCH/POST/PUT/DELETE on a path with
 * `/locations/<id>`, from the host's tools or the admin console (details, prices, photos,
 * timings, sections, moderation...) -- refresh that listing on the website before answering.
 * Done before the response rather than after it because a serverless function may be frozen the
 * moment it has answered; the call is bounded to 2.5 s and its failure is only logged.
 */
export function websiteRevalidate(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS" || !env.WEBSITE_REVALIDATE_URL) {
    next();
    return;
  }
  const match = LOCATION_ID.exec(req.originalUrl.split("?")[0] ?? "");
  if (!match) {
    next();
    return;
  }
  const locationId = match[1]!.toLowerCase();
  const send = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode >= 400) return send(body);
    void revalidateWebsiteListings([locationId]).finally(() => send(body));
    return res;
  }) as Response["json"];
  next();
}

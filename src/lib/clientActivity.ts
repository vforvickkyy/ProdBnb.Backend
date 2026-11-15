import { Request } from "express";
import { clientInfo } from "./clientInfo";
import { adminClient } from "./supabase";

// Admin Console 2 -- "which app versions are actually running" (the Platforms page).

const seen = new Set<string>();
let seenDay = "";

/**
 * Records (day, platform, version, user) once per instance per day for a signed-in client that
 * sends X-ProdBnb-Platform + X-ProdBnb-App-Version. Fire-and-forget: telemetry must never slow
 * down or fail the request it rides on.
 */
export function noteClientActivity(req: Request, userId: string): void {
  const info = clientInfo(req);
  if (!info.platform || !info.appVersion) {
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  if (day !== seenDay) {
    seen.clear();
    seenDay = day;
  }
  const key = `${info.platform}|${info.appVersion}|${userId}`;
  if (seen.has(key) || seen.size > 50_000) {
    return;
  }
  seen.add(key);
  void adminClient
    .from("client_version_activity")
    .upsert(
      { day, platform: info.platform, app_version: info.appVersion, user_id: userId },
      { onConflict: "day,platform,app_version,user_id", ignoreDuplicates: true }
    )
    .then(({ error }) => {
      if (error) {
        seen.delete(key);
        console.error("Failed to record client version activity:", error.message);
      }
    });
}


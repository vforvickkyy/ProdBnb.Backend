import { Request } from "express";

/**
 * Admin Console 2: what a client tells the backend about itself.
 *
 *   X-ProdBnb-Platform      ios | android | web
 *   X-ProdBnb-App-Version   e.g. 1.4.2
 *   X-ProdBnb-Capabilities  comma-separated opt-ins, e.g. "announcements"
 *
 * All optional. The iOS build already in the field sends none of them, and must keep getting
 * exactly the responses it gets today -- every feature keyed on these is opt-in.
 */
export type ClientPlatform = "ios" | "android" | "web";

export interface ClientInfo {
  platform: ClientPlatform | null;
  appVersion: string | null;
  capabilities: Set<string>;
}

const PLATFORMS = new Set(["ios", "android", "web"]);
const VERSION = /^\d+(\.\d+){0,3}$/;

export function clientInfo(req: Request): ClientInfo {
  const platform = (req.header("x-prodbnb-platform") ?? "").trim().toLowerCase();
  const version = (req.header("x-prodbnb-app-version") ?? "").trim();
  const capabilities = new Set(
    (req.header("x-prodbnb-capabilities") ?? "")
      .split(",")
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean)
  );
  return {
    platform: PLATFORMS.has(platform) ? (platform as ClientPlatform) : null,
    appVersion: VERSION.test(version) && version.length <= 32 ? version : null,
    capabilities,
  };
}

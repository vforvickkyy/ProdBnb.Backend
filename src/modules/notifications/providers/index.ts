import { env } from "../../../config/env";
import { apnsCredentials, fcmCredentials, webPushCredentials } from "../../outreach/channels.service";
import { APNsProvider } from "./APNsProvider";
import { DisabledProvider } from "./DisabledProvider";
import { FCMProvider } from "./FCMProvider";
import { NotificationProvider } from "./NotificationProvider";
import { WebPushProvider } from "./WebPushProvider";

/**
 * Resolves the push provider for ONE device platform (Admin Console 2; before this there was a
 * single provider for everything, chosen by env.NOTIFICATION_PROVIDER).
 *
 *   ios      APNs -- the dashboard-connected key if there is one, else the original APNS_* env
 *            configuration when NOTIFICATION_PROVIDER=apns, else disabled
 *   android  FCM  -- dashboard-connected service account, else disabled
 *   web      Web Push -- dashboard-connected VAPID keys, else disabled
 *
 * "disabled" is not an error: its send() records an honest 'skipped' delivery attempt, exactly as
 * NOTIFICATION_PROVIDER=disabled always has. Instances are cached per credential version, so a
 * re-connected channel takes effect without a restart.
 */
const disabled = new DisabledProvider();
let envApns: APNsProvider | null = null;
const instances = new Map<string, { version: string; provider: NotificationProvider }>();

function cached(key: string, version: string, build: () => NotificationProvider): NotificationProvider {
  const hit = instances.get(key);
  if (hit && hit.version === version) {
    return hit.provider;
  }
  const provider = build();
  instances.set(key, { version, provider });
  return provider;
}

export async function getNotificationProvider(platform: "ios" | "android" | "web" = "ios"): Promise<NotificationProvider> {
  if (platform === "ios") {
    const stored = await apnsCredentials();
    if (stored) {
      return cached("apns", stored.version, () => new APNsProvider(stored.credentials));
    }
    if (env.NOTIFICATION_PROVIDER === "apns") {
      envApns ??= new APNsProvider();
      return envApns;
    }
    return disabled;
  }
  if (platform === "android") {
    const stored = await fcmCredentials();
    return stored ? cached("fcm", stored.version, () => new FCMProvider(stored.credentials)) : disabled;
  }
  const stored = await webPushCredentials();
  return stored ? cached("webpush", stored.version, () => new WebPushProvider(stored.credentials)) : disabled;
}

import webpush from "web-push";
import { NotificationProvider, SendPushInput, SendPushResult } from "./NotificationProvider";

/**
 * Browser push (the future web app) via the standard Web Push protocol with VAPID keys
 * (Admin Console 2). `deviceToken` is the subscription endpoint; its p256dh/auth keys are stored
 * alongside it in user_devices.web_push_keys. Payload encryption (RFC 8291) is done by the
 * `web-push` library.
 */
export interface WebPushCredentials {
  publicKey: string;
  privateKey: string;
  /** A mailto: or https: contact the push service can reach about this sender. */
  subject: string;
}

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}

export class WebPushProvider implements NotificationProvider {
  readonly name = "webpush" as const;

  constructor(private readonly credentials: WebPushCredentials) {}

  async send(input: SendPushInput): Promise<SendPushResult> {
    if (!input.webPushKeys) {
      return { status: "invalid_token", providerMessageId: null, errorReason: "MissingSubscriptionKeys" };
    }
    try {
      const result = await webpush.sendNotification(
        { endpoint: input.deviceToken, keys: input.webPushKeys },
        JSON.stringify({ title: input.title, body: input.body, data: input.data, tag: input.threadId ?? undefined }),
        {
          TTL: 24 * 60 * 60,
          vapidDetails: {
            subject: this.credentials.subject,
            publicKey: this.credentials.publicKey,
            privateKey: this.credentials.privateKey,
          },
        }
      );
      return { status: "sent", providerMessageId: result.headers?.location ?? null, errorReason: null };
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      // 404/410: the subscription has expired or been revoked by the user.
      if (statusCode === 404 || statusCode === 410) {
        return { status: "invalid_token", providerMessageId: null, errorReason: `HTTP ${statusCode}` };
      }
      return {
        status: "failed",
        providerMessageId: null,
        errorReason: statusCode ? `HTTP ${statusCode}` : error instanceof Error ? error.message.slice(0, 200) : "Web Push error",
      };
    }
  }
}

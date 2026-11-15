import { z } from "zod";

const uuid = z.string().uuid();

export const devicePlatformSchema = z.enum(["ios", "android", "web"]);
export type DevicePlatform = z.infer<typeof devicePlatformSchema>;

export const deviceEnvironmentSchema = z.enum(["sandbox", "production"]);
export type DeviceEnvironment = z.infer<typeof deviceEnvironmentSchema>;

// No user_id field -- the recipient is always the authenticated caller,
// never client-supplied (same as every other "create a resource for
// yourself" endpoint in this codebase).
export const registerDeviceSchema = z
  .object({
    device_token: z.string().trim().min(1).max(4096),
    platform: devicePlatformSchema,
    environment: deviceEnvironmentSchema.optional(),
    // Admin Console 2 -- both optional, so the iOS build in the field registers exactly as before.
    app_version: z
      .string()
      .trim()
      .regex(/^\d+(\.\d+){0,3}$/, "A version like 1.4.2.")
      .max(32)
      .optional(),
    /** Web Push only: the PushSubscription's keys (device_token is its endpoint). */
    web_push_keys: z
      .object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((d) => d.platform !== "web" || d.web_push_keys !== undefined, {
    message: "A web push registration needs web_push_keys (p256dh + auth) from the PushSubscription.",
    path: ["web_push_keys"],
  })
  .refine((d) => d.platform !== "web" || /^https:\/\//.test(d.device_token), {
    message: "For web, device_token is the PushSubscription endpoint (an https:// URL).",
    path: ["device_token"],
  });
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;

export const deviceIdParamSchema = z.object({ id: uuid });
export type DeviceIdParam = z.infer<typeof deviceIdParamSchema>;

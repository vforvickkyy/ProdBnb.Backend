import { z } from "zod";

const uuid = z.string().uuid();
const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);

export const channelNameSchema = z.enum(["smtp", "apns", "fcm", "webpush"]);
export type ChannelName = z.infer<typeof channelNameSchema>;

export const channelParamSchema = z.object({ channel: channelNameSchema });
export type ChannelParam = z.infer<typeof channelParamSchema>;

/**
 * One form per channel. Secret fields (password, private keys, the service-account JSON) are
 * optional on purpose: the dashboard never receives a stored secret back, so "leave blank to keep
 * the current one" is the only way to edit the non-secret settings of a connected channel.
 */
const smtpSchema = z
  .object({
    channel: z.literal("smtp"),
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    username: z.string().trim().max(255).nullable().optional(),
    password: z.string().min(1).max(1000).optional(),
    from_email: z.string().trim().email(),
    from_name: z.string().trim().min(1).max(120),
    reply_to: z.string().trim().email().nullable().optional(),
    max_per_minute: z.number().int().min(1).max(1000).default(60),
  })
  .strict();

const apnsSchema = z
  .object({
    channel: z.literal("apns"),
    team_id: z.string().trim().regex(/^[A-Z0-9]{10}$/, "Apple Team ID: 10 letters/digits."),
    key_id: z.string().trim().regex(/^[A-Z0-9]{10}$/, "APNs Key ID: 10 letters/digits."),
    bundle_id: z.string().trim().min(3).max(155).regex(/^[A-Za-z0-9.-]+$/, "A bundle id like com.prodbnb.app."),
    environment: z.enum(["production", "sandbox"]),
    private_key: z.string().min(1).max(10_000).optional(),
  })
  .strict();

const fcmSchema = z
  .object({
    channel: z.literal("fcm"),
    service_account_json: z.string().min(1).max(20_000).optional(),
  })
  .strict();

const webPushSchema = z
  .object({
    channel: z.literal("webpush"),
    subject: z
      .string()
      .trim()
      .regex(/^(mailto:\S+@\S+|https:\/\/\S+)$/, "A contact such as mailto:ops@prodbnb.com or https://prodbnb.com."),
    generate_keys: z.boolean().default(false),
    public_key: z.string().trim().min(10).max(200).optional(),
    private_key: z.string().trim().min(10).max(200).optional(),
  })
  .strict();

export const saveChannelSchema = z.discriminatedUnion("channel", [smtpSchema, apnsSchema, fcmSchema, webPushSchema]);
export type SaveChannelInput = z.infer<typeof saveChannelSchema>;

export const channelEnabledSchema = z.object({ enabled: z.boolean() }).strict();
export type ChannelEnabledInput = z.infer<typeof channelEnabledSchema>;

export const testChannelSchema = z
  .object({
    /** smtp: where to send the test (defaults to the signed-in admin's own address). */
    to: z.string().trim().email().optional(),
    /** push: a device to deliver to (defaults to the admin's own devices on that platform). */
    device_id: uuid.optional(),
  })
  .strict()
  .default({});
export type TestChannelInput = z.infer<typeof testChannelSchema>;

// -- Campaigns ---------------------------------------------------------------------------------------

export const campaignChannelSchema = z.enum(["in_app", "push", "email"]);
export const pushPlatformSchema = z.enum(["ios", "android", "web"]);

export const audienceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("all") }).strict(),
  z.object({ type: z.literal("role"), role: z.enum(["booker", "host", "admin"]) }).strict(),
  z.object({ type: z.literal("users"), user_ids: z.array(uuid).min(1).max(5000) }).strict(),
  z.object({ type: z.literal("platform_users") }).strict(),
]);
export type Audience = z.infer<typeof audienceSchema>;

const campaignFields = {
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["announcement", "direct"]).default("announcement"),
  channels: z.array(campaignChannelSchema).min(1).max(3),
  platforms: z.array(pushPlatformSchema).min(1).max(3).default(["ios", "android", "web"]),
  audience: audienceSchema,
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(1000),
  link_url: z
    .string()
    .trim()
    .max(500)
    .regex(/^(https:\/\/|prodbnb:\/\/)\S+$/, "Use an https:// link or a prodbnb:// app link.")
    .nullable()
    .optional(),
  email_subject: z.string().trim().min(1).max(200).nullable().optional(),
  email_body: z.string().trim().min(1).max(50_000).nullable().optional(),
};

function emailFieldsPresent(d: { channels?: string[]; email_subject?: string | null; email_body?: string | null }): boolean {
  return !d.channels?.includes("email") || (Boolean(d.email_subject) && Boolean(d.email_body));
}

export const createCampaignSchema = z
  .object(campaignFields)
  .strict()
  .refine((d) => new Set(d.channels).size === d.channels.length, { message: "Duplicate channel.", path: ["channels"] })
  .refine(emailFieldsPresent, { message: "Email needs a subject and a body.", path: ["email_subject"] });
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

export const updateCampaignSchema = z
  .object({
    name: campaignFields.name.optional(),
    channels: campaignFields.channels.optional(),
    platforms: z.array(pushPlatformSchema).min(1).max(3).optional(),
    audience: audienceSchema.optional(),
    title: campaignFields.title.optional(),
    body: campaignFields.body.optional(),
    link_url: campaignFields.link_url,
    email_subject: campaignFields.email_subject,
    email_body: campaignFields.email_body,
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: "Provide at least one field to update." });
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;

export const campaignIdParamSchema = z.object({ campaignId: uuid });
export type CampaignIdParam = z.infer<typeof campaignIdParamSchema>;

export const sendCampaignSchema = z
  .object({
    /** Omit to send now. A time in the future schedules it (needs background jobs enabled). */
    scheduled_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .default({});
export type SendCampaignInput = z.infer<typeof sendCampaignSchema>;

export const listCampaignsQuerySchema = z.object({
  page,
  pageSize,
  status: z.enum(["draft", "scheduled", "sending", "sent", "cancelled", "failed"]).optional(),
  kind: z.enum(["announcement", "direct"]).optional(),
});
export type ListCampaignsQuery = z.infer<typeof listCampaignsQuerySchema>;

export const campaignRecipientsQuerySchema = z.object({
  page,
  pageSize,
  filter: z.enum(["all", "failed", "pending"]).default("all"),
});
export type CampaignRecipientsQuery = z.infer<typeof campaignRecipientsQuerySchema>;

export const audiencePreviewSchema = z
  .object({
    audience: audienceSchema,
    platforms: z.array(pushPlatformSchema).min(1).max(3).default(["ios", "android", "web"]),
  })
  .strict();
export type AudiencePreviewInput = z.infer<typeof audiencePreviewSchema>;

export const testCampaignSchema = z
  .object({
    channels: z.array(campaignChannelSchema).min(1).max(3),
    platforms: z.array(pushPlatformSchema).min(1).max(3).default(["ios", "android", "web"]),
    title: campaignFields.title,
    body: campaignFields.body,
    link_url: campaignFields.link_url,
    email_subject: campaignFields.email_subject,
    email_body: campaignFields.email_body,
  })
  .strict()
  .refine(emailFieldsPresent, { message: "Email needs a subject and a body.", path: ["email_subject"] });
export type TestCampaignInput = z.infer<typeof testCampaignSchema>;

// -- Background jobs ---------------------------------------------------------------------------------

export const jobsConfigSchema = z
  .object({
    dispatch_url: z
      .string()
      .trim()
      .url()
      .regex(/^https?:\/\//)
      .nullable()
      .optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: "Provide dispatch_url and/or enabled." });
export type JobsConfigInput = z.infer<typeof jobsConfigSchema>;

export const unsubscribeQuerySchema = z.object({ token: z.string().min(10).max(500) });
export type UnsubscribeQuery = z.infer<typeof unsubscribeQuerySchema>;

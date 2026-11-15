import { z } from "zod";

const uuid = z.string().uuid();
const version = z.string().trim().regex(/^\d+(\.\d+){0,3}$/, "A version like 1.4.2.");
const nullableVersion = version.nullable().optional();
const shortText = (max: number) => z.string().trim().max(max).nullable().optional();

export const clientPlatformSchema = z.enum(["ios", "android", "web"]);
export const anyPlatformSchema = z.enum(["ios", "android", "web", "backend", "admin"]);

export const platformParamSchema = z.object({ platform: clientPlatformSchema });
export type PlatformParam = z.infer<typeof platformParamSchema>;

export const updatePlatformSchema = z
  .object({
    display_name: z.string().trim().min(1).max(60).optional(),
    status: z.enum(["not_launched", "in_development", "beta", "live", "maintenance", "deprecated"]).optional(),
    live_version: nullableVersion,
    latest_version: nullableVersion,
    min_supported_version: nullableVersion,
    store_url: z.string().trim().url().regex(/^https:\/\//, "Must be an https:// link.").nullable().optional(),
    update_message: shortText(300),
    force_update_message: shortText(300),
    maintenance_mode: z.boolean().optional(),
    maintenance_message: shortText(300),
    notes: shortText(5000),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: "Provide at least one field to update." });
export type UpdatePlatformInput = z.infer<typeof updatePlatformSchema>;

const flagTargetSchema = z.object({ enabled: z.boolean(), min_version: version.nullable().optional() }).strict();
const flagTargetsSchema = z
  .object({ ios: flagTargetSchema.optional(), android: flagTargetSchema.optional(), web: flagTargetSchema.optional() })
  .strict();

export const flagIdParamSchema = z.object({ flagId: uuid });
export type FlagIdParam = z.infer<typeof flagIdParamSchema>;

export const createFeatureFlagSchema = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_.-]{1,63}$/, "Lowercase, starting with a letter, e.g. collections_home."),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).default(""),
    targets: flagTargetsSchema.default({}),
  })
  .strict();
export type CreateFeatureFlagInput = z.infer<typeof createFeatureFlagSchema>;

export const updateFeatureFlagSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).optional(),
    targets: flagTargetsSchema.optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: "Provide at least one field to update." });
export type UpdateFeatureFlagInput = z.infer<typeof updateFeatureFlagSchema>;

const incidentStatus = z.enum(["investigating", "identified", "monitoring", "resolved"]);

export const incidentIdParamSchema = z.object({ incidentId: uuid });
export type IncidentIdParam = z.infer<typeof incidentIdParamSchema>;

export const createIncidentSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().max(1000).default(""),
    severity: z.enum(["minor", "major", "critical"]).default("minor"),
    status: incidentStatus.default("investigating"),
    platforms: z.array(anyPlatformSchema).min(1).max(5),
    is_public: z.boolean().default(false),
    message: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;

export const updateIncidentSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    summary: z.string().trim().max(1000).optional(),
    severity: z.enum(["minor", "major", "critical"]).optional(),
    status: incidentStatus.optional(),
    platforms: z.array(anyPlatformSchema).min(1).max(5).optional(),
    is_public: z.boolean().optional(),
    /** Adds a timeline entry. */
    message: z.string().trim().min(1).max(2000).optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: "Provide at least one field to update." });
export type UpdateIncidentInput = z.infer<typeof updateIncidentSchema>;

const releaseStatus = z.enum(["planned", "in_progress", "in_review", "released", "cancelled"]);

export const releaseIdParamSchema = z.object({ releaseId: uuid });
export type ReleaseIdParam = z.infer<typeof releaseIdParamSchema>;

export const createReleaseSchema = z
  .object({
    platform: anyPlatformSchema,
    version: z.string().trim().min(1).max(32),
    title: z.string().trim().min(1).max(160),
    notes: z.string().trim().max(10_000).default(""),
    status: releaseStatus.default("planned"),
    target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    feature_keys: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
    /** When the release is (or becomes) `released`, also set the platform's live + latest version. */
    promote_to_live: z.boolean().default(false),
  })
  .strict();
export type CreateReleaseInput = z.infer<typeof createReleaseSchema>;

export const updateReleaseSchema = z
  .object({
    version: z.string().trim().min(1).max(32).optional(),
    title: z.string().trim().min(1).max(160).optional(),
    notes: z.string().trim().max(10_000).optional(),
    status: releaseStatus.optional(),
    target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    feature_keys: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
    promote_to_live: z.boolean().default(false),
  })
  .strict();
export type UpdateReleaseInput = z.infer<typeof updateReleaseSchema>;

/** Public. `version` is optional: without it the app still gets status, maintenance and incidents. */
export const appConfigQuerySchema = z.object({
  platform: clientPlatformSchema,
  version: version.optional(),
});
export type AppConfigQuery = z.infer<typeof appConfigQuerySchema>;

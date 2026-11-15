import { z } from "zod";
import { updateLocationSchema } from "../locations/locations.schema";

const uuid = z.string().uuid();

export const adminUserIdParamSchema = z.object({ id: uuid });
export type AdminUserIdParam = z.infer<typeof adminUserIdParamSchema>;

export const suspendUserSchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();
export type SuspendUserInput = z.infer<typeof suspendUserSchema>;

// No fields required — restoring/approving is never required to justify
// itself the way a rejection/suspension is (Phase 11 plan §16).
export const noBodySchema = z.object({}).strict().default({});
export type NoBodyInput = z.infer<typeof noBodySchema>;

export const rejectLocationSchema = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();
export type RejectLocationInput = z.infer<typeof rejectLocationSchema>;

export const suspendLocationSchema = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();
export type SuspendLocationInput = z.infer<typeof suspendLocationSchema>;

const dateTimeFilter = z.string().datetime({ offset: true });

export const adminListPaymentsQuerySchema = z
  .object({
    status: z.enum(["created", "pending", "success", "failed", "cancelled", "refunded", "partially_refunded"]).optional(),
    provider: z.enum(["cashfree"]).optional(),
    booking_id: uuid.optional(),
    // Filters on the payment's own created_at (Phase 14) -- unlike bookings,
    // a payment has no separate "when does this happen" date, so created_at
    // is the natural and only reasonable filter here.
    created_after: dateTimeFilter.optional(),
    created_before: dateTimeFilter.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((d) => !d.created_after || !d.created_before || d.created_before >= d.created_after, {
    message: "created_before must not be earlier than created_after.",
    path: ["created_before"],
  });
export type AdminListPaymentsQuery = z.infer<typeof adminListPaymentsQuerySchema>;

export const adminListRefundsQuerySchema = z.object({
  status: z.enum(["pending", "success", "failed", "cancelled"]).optional(),
  // Lets an admin jump straight to "every refund for this payment" instead
  // of paging through an unfiltered list client-side (Phase 14).
  payment_id: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type AdminListRefundsQuery = z.infer<typeof adminListRefundsQuerySchema>;

export const deliveryAttemptsQuerySchema = z
  .object({
    notification_id: uuid.optional(),
    booking_id: uuid.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((d) => d.notification_id !== undefined || d.booking_id !== undefined, {
    message: "Provide notification_id or booking_id.",
  });
export type DeliveryAttemptsQuery = z.infer<typeof deliveryAttemptsQuerySchema>;

// Mirrors audit.service.ts's AuditAction union exactly (not imported from
// there -- audit.service.ts already imports AuditLogQuery from this file,
// and importing the type back would create a circular dependency; the two
// lists are small and only change together, at the same migration that
// extends admin_audit_log's own CHECK constraint).
export const auditActionSchema = z.enum([
  "ADMIN_APPROVED_LOCATION",
  "ADMIN_REJECTED_LOCATION",
  "ADMIN_SUSPENDED_LOCATION",
  "ADMIN_RESTORED_LOCATION",
  "ADMIN_UPDATED_LOCATION_STATUS",
  "ADMIN_SUSPENDED_USER",
  "ADMIN_RESTORED_USER",
  "ADMIN_CANCELLED_BOOKING",
  "ADMIN_CREATED_REFUND",
  "ADMIN_CONFIRMED_BOOKING",
  "ADMIN_REJECTED_BOOKING",
  "ADMIN_COMPLETED_BOOKING",
  "ADMIN_VERIFIED_PAYMENT",
  "ADMIN_UPDATED_LOCATION",
  "ADMIN_DELETED_MEDIA",
  "ADMIN_DELETED_SECTION",
  "ADMIN_CREATED_CATALOG_ITEM",
  "ADMIN_UPDATED_CATALOG_ITEM",
  "ADMIN_DELETED_CATALOG_ITEM",
  "ADMIN_GRANTED_ROLE",
  "ADMIN_REVOKED_ROLE",
  "ADMIN_SET_TEAM_ROLE",
  "ADMIN_REMOVED_TEAM_MEMBER",
  "ADMIN_UPDATED_SETTINGS",
]);

export const auditTargetTypeSchema = z.enum(["location", "user", "booking", "payment", "media", "section", "catalog_item", "settings"]);

export const auditLogQuerySchema = z
  .object({
    target_type: auditTargetTypeSchema.optional(),
    target_id: uuid.optional(),
    admin_id: uuid.optional(),
    // Phase 14: finding "every rejection this week" required pulling every
    // page and filtering client-side without these.
    action: auditActionSchema.optional(),
    created_after: dateTimeFilter.optional(),
    created_before: dateTimeFilter.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((d) => !d.created_after || !d.created_before || d.created_before >= d.created_after, {
    message: "created_before must not be earlier than created_after.",
    path: ["created_before"],
  });
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

// ============================================================================
// Admin Console
// ============================================================================

const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);

// -- Team ---------------------------------------------------------------------

export const teamRoleSchema = z.enum(["super_admin", "moderator", "support", "finance"]);

export const teamUserIdParamSchema = z.object({ userId: uuid });
export type TeamUserIdParam = z.infer<typeof teamUserIdParamSchema>;

export const setTeamRoleSchema = z.object({ team_role: teamRoleSchema }).strict();
export type SetTeamRoleInput = z.infer<typeof setTeamRoleSchema>;

export const addTeamMemberSchema = z
  .object({ email: z.string().trim().email().max(320), team_role: teamRoleSchema })
  .strict();
export type AddTeamMemberInput = z.infer<typeof addTeamMemberSchema>;

// -- Platform settings ----------------------------------------------------------

/**
 * Basis points, integers (1 bp = 0.01%; 1800 = 18%). Capped at 50% each -- a guard against a
 * mistyped value (e.g. 180000 meant as 18%), not a business limit. `unpaid_hold_minutes: null`
 * turns expiry off; the 5-minute floor stops a hold expiring under someone mid-checkout, the
 * 7-day ceiling keeps it a hold rather than a reservation.
 */
export const updateSettingsSchema = z
  .object({
    platform_fee_bps: z.number().int().min(0).max(5000).optional(),
    tax_bps: z.number().int().min(0).max(5000).optional(),
    unpaid_hold_minutes: z.number().int().min(5).max(10080).nullable().optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((d) => d.platform_fee_bps !== undefined || d.tax_bps !== undefined || d.unpaid_hold_minutes !== undefined, {
    message: "Provide at least one setting to change.",
  });
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

// -- Catalog -------------------------------------------------------------------

export const catalogKindSchema = z.enum(["categories", "amenities", "use-cases"]);
export const catalogKindParamSchema = z.object({ kind: catalogKindSchema });
export type CatalogKindParam = z.infer<typeof catalogKindParamSchema>;
export const catalogItemParamSchema = z.object({ kind: catalogKindSchema, itemId: uuid });
export type CatalogItemParam = z.infer<typeof catalogItemParamSchema>;
export const catalogNameSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export type CatalogNameInput = z.infer<typeof catalogNameSchema>;

// -- Listing moderation ----------------------------------------------------------

export const optionalReasonSchema = z
  .object({ reason: z.string().trim().min(1).max(1000).optional() })
  .strict()
  .default({});
export type OptionalReasonInput = z.infer<typeof optionalReasonSchema>;

export const locationMediaParamSchema = z.object({ id: uuid, mediaId: uuid });
export type LocationMediaParam = z.infer<typeof locationMediaParamSchema>;
export const locationSectionParamSchema = z.object({ id: uuid, sectionId: uuid });
export type LocationSectionParam = z.infer<typeof locationSectionParamSchema>;

/**
 * Content an admin may correct on someone's listing: exactly the host's own editable fields
 * (derived from updateLocationSchema, so the two can never drift), minus `status` -- which only
 * moves through the audited moderation actions -- plus an optional reason for the audit entry.
 */
export const adminUpdateLocationSchema = updateLocationSchema
  .innerType()
  .omit({ status: true })
  .extend({ reason: z.string().trim().min(1).max(1000).optional() })
  .strict()
  .refine((d) => Object.keys(d).some((k) => k !== "reason"), { message: "Provide at least one field to update." });
export type AdminUpdateLocationInput = z.infer<typeof adminUpdateLocationSchema>;

// -- People ---------------------------------------------------------------------

export const userRoleParamSchema = z.object({ id: uuid, role: z.enum(["booker", "host"]) });
export type UserRoleParam = z.infer<typeof userRoleParamSchema>;

// -- Dispute message access -------------------------------------------------------

export const adminConversationsQuerySchema = z.object({
  booker_id: uuid.optional(),
  host_id: uuid.optional(),
  location_id: uuid.optional(),
  booking_id: uuid.optional(),
  page,
  pageSize,
});
export type AdminConversationsQuery = z.infer<typeof adminConversationsQuerySchema>;

export const conversationIdParamSchema = z.object({ id: uuid });
export type ConversationIdParam = z.infer<typeof conversationIdParamSchema>;

/**
 * A real sentence, not a checkbox: at least 10 characters. The database also refuses a blank
 * reason (admin_message_access_reason CHECK), but "x" would satisfy that.
 */
export const openConversationSchema = z
  .object({ reason: z.string().trim().min(10, "Explain why you need to read this conversation (at least 10 characters).").max(1000) })
  .strict();
export type OpenConversationInput = z.infer<typeof openConversationSchema>;

export const messageAccessLogQuerySchema = z.object({
  conversation_id: uuid.optional(),
  admin_user_id: uuid.optional(),
  page,
  pageSize,
});
export type MessageAccessLogQuery = z.infer<typeof messageAccessLogQuerySchema>;

// -- Analytics / integrations -------------------------------------------------------

export const analyticsQuerySchema = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    bucket: z.enum(["day", "week", "month"]).default("day"),
    tz: z
      .string()
      .default("Asia/Kolkata")
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Must be an IANA time zone, e.g. Asia/Kolkata."),
  })
  .refine((d) => new Date(d.to) > new Date(d.from), { message: "to must be after from.", path: ["to"] })
  .refine((d) => new Date(d.to).getTime() - new Date(d.from).getTime() <= 400 * 86_400_000, {
    message: "Range can be at most 400 days.",
    path: ["from"],
  });
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

export const integrationsQuerySchema = z.object({
  check: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});
export type IntegrationsQuery = z.infer<typeof integrationsQuerySchema>;

export const attentionQuerySchema = z.object({ page, pageSize });
export type AttentionQuery = z.infer<typeof attentionQuerySchema>;

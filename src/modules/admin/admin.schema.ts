import { z } from "zod";
import { createLocationSchema, updateLocationSchema } from "../locations/locations.schema";

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
  // Admin Console 2 (migration 20261115140000_admin_console_2_audit_vocabulary.sql)
  "ADMIN_CREATED_LOCATION",
  "ADMIN_UPLOADED_MEDIA",
  "ADMIN_REORDERED_MEDIA",
  "ADMIN_UPDATED_PRICING",
  "ADMIN_UPDATED_AVAILABILITY",
  "ADMIN_UPDATED_SECTION",
  "ADMIN_UPDATED_CATALOG_LISTINGS",
  "ADMIN_UPDATED_CATALOG_COVER",
  "ADMIN_CREATED_COLLECTION",
  "ADMIN_UPDATED_COLLECTION",
  "ADMIN_DELETED_COLLECTION",
  "ADMIN_SENT_CAMPAIGN",
  "ADMIN_CANCELLED_CAMPAIGN",
  "ADMIN_CONNECTED_CHANNEL",
  "ADMIN_DISCONNECTED_CHANNEL",
  "ADMIN_UPDATED_JOBS_CONFIG",
  "ADMIN_UPDATED_PLATFORM",
  "ADMIN_UPDATED_FEATURE_FLAG",
  "ADMIN_DELETED_FEATURE_FLAG",
  "ADMIN_CREATED_INCIDENT",
  "ADMIN_UPDATED_INCIDENT",
  "ADMIN_CREATED_RELEASE",
  "ADMIN_UPDATED_RELEASE",
  "ADMIN_DELETED_RELEASE",
  // Website (Console 3)
  "ADMIN_CONNECTED_SITE_INTEGRATION",
  "ADMIN_DISCONNECTED_SITE_INTEGRATION",
  "ADMIN_ADDED_DOMAIN",
  "ADMIN_UPDATED_DOMAIN",
  "ADMIN_REMOVED_DOMAIN",
  "ADMIN_SET_PRIMARY_DOMAIN",
  // Website pages and SEO (migration 20261116110000_search_budget_pages_seo.sql)
  "ADMIN_CREATED_PAGE",
  "ADMIN_UPDATED_PAGE",
  "ADMIN_DELETED_PAGE",
  "ADMIN_UPDATED_SEO",
  // Booker account (migration 20261116120000_booker_account.sql)
  "ADMIN_APPROVED_REFUND_REQUEST",
  "ADMIN_DECLINED_REFUND_REQUEST",
  "ADMIN_COMPLETED_ACCOUNT_DELETION",
  "ADMIN_DECLINED_ACCOUNT_DELETION",
  // Host payouts (migration 20261117100000_host_payouts.sql)
  "ADMIN_VIEWED_PAYOUT_DETAILS",
  "ADMIN_RECORDED_PAYOUT",
  // Coupons
  "ADMIN_CREATED_COUPON",
  "ADMIN_UPDATED_COUPON",
  "ADMIN_DELETED_COUPON",
  // Invoices and receipts
  "ADMIN_UPDATED_INVOICE_SETTINGS",
  "ADMIN_ISSUED_INVOICES",
  "ADMIN_SENT_INVOICE",
  "ADMIN_SENT_RECEIPT",
  "ADMIN_CREATED_NOTIFICATION_TEMPLATE",
  "ADMIN_UPDATED_NOTIFICATION_TEMPLATE",
  "ADMIN_DELETED_NOTIFICATION_TEMPLATE",
]);

export const auditTargetTypeSchema = z.enum([
  "location",
  "user",
  "booking",
  "payment",
  "media",
  "section",
  "catalog_item",
  "settings",
  "collection",
  "campaign",
  "channel",
  "platform",
  "feature_flag",
  "incident",
  "release",
  "site_integration",
  "site",
  "site_page",
  "seo",
  "refund_request",
  "deletion_request",
  "payout_account",
  "payout",
  "coupon",
  "invoice",
  "notification_template",
]);

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
    availability_requires_login: z.boolean().optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine(
    (d) =>
      d.platform_fee_bps !== undefined ||
      d.tax_bps !== undefined ||
      d.unpaid_hold_minutes !== undefined ||
      d.availability_requires_login !== undefined,
    {
      message: "Provide at least one setting to change.",
    }
  );
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

// -- Catalog -------------------------------------------------------------------

export const catalogKindSchema = z.enum(["categories", "amenities", "use-cases"]);
export const catalogKindParamSchema = z.object({ kind: catalogKindSchema });
export type CatalogKindParam = z.infer<typeof catalogKindParamSchema>;
export const catalogItemParamSchema = z.object({ kind: catalogKindSchema, itemId: uuid });
export type CatalogItemParam = z.infer<typeof catalogItemParamSchema>;
const catalogDescription = z.string().trim().max(500).nullable();

export const catalogNameSchema = z
  .object({ name: z.string().trim().min(1).max(80), description: catalogDescription.optional() })
  .strict();
export type CatalogNameInput = z.infer<typeof catalogNameSchema>;

export const catalogUpdateSchema = z
  .object({ name: z.string().trim().min(1).max(80).optional(), description: catalogDescription.optional() })
  .strict()
  .refine((d) => d.name !== undefined || d.description !== undefined, { message: "Provide name and/or description." });
export type CatalogUpdateInput = z.infer<typeof catalogUpdateSchema>;

// -- Cover images (catalog items + collections) ------------------------------------

export const coverUploadRequestSchema = z
  .object({
    content_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
    size_bytes: z.number().int().positive(),
  })
  .strict();
export type CoverUploadRequestInput = z.infer<typeof coverUploadRequestSchema>;

export const coverCompleteSchema = z.object({ storage_key: z.string().min(1).max(300) }).strict();
export type CoverCompleteInput = z.infer<typeof coverCompleteSchema>;

// -- Listings inside a catalog item ---------------------------------------------------

export const catalogListingsQuerySchema = z.object({ page, pageSize });
export type CatalogListingsQuery = z.infer<typeof catalogListingsQuerySchema>;

export const locationIdsSchema = z
  .object({ location_ids: z.array(uuid).min(1).max(100) })
  .strict()
  .refine((d) => new Set(d.location_ids).size === d.location_ids.length, {
    message: "location_ids must not contain duplicates.",
    path: ["location_ids"],
  });
export type LocationIdsInput = z.infer<typeof locationIdsSchema>;

export const catalogListingParamSchema = z.object({
  kind: z.enum(["categories", "amenities", "use-cases"]),
  itemId: uuid,
  locationId: uuid,
});
export type CatalogListingParam = z.infer<typeof catalogListingParamSchema>;

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
  .extend({
    reason: z.string().trim().min(1).max(1000).optional(),
    /** The team's call, never the host's: show the full address and exact pin before booking. */
    show_exact_location: z.boolean().optional(),
  })
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

// ============================================================================
// Admin Console 2 -- listings created on a host's behalf
// ============================================================================

/**
 * POST /v1/admin/locations. The host's own create body (derived, so the two cannot drift) plus who
 * owns it and whether it goes live immediately.
 */
export const adminCreateLocationSchema = createLocationSchema
  .extend({
    host_id: uuid,
    grant_host_role: z.boolean().default(false),
    status: z.enum(["draft", "published"]).default("draft"),
    show_exact_location: z.boolean().optional(),
  })
  .strict();
export type AdminCreateLocationInput = z.infer<typeof adminCreateLocationSchema>;

export const hostSearchQuerySchema = z.object({
  search: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  hosts_only: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});
export type HostSearchQuery = z.infer<typeof hostSearchQuerySchema>;

// -- Collections -------------------------------------------------------------------------------

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Lowercase letters, numbers and single hyphens only, e.g. beach-villas-goa.");

export const collectionIdParamSchema = z.object({ collectionId: uuid });
export type CollectionIdParam = z.infer<typeof collectionIdParamSchema>;

export const collectionListingParamSchema = z.object({ collectionId: uuid, locationId: uuid });
export type CollectionListingParam = z.infer<typeof collectionListingParamSchema>;

export const collectionCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    slug: slugSchema,
    description: z.string().trim().max(1000).default(""),
    is_published: z.boolean().default(false),
    position: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();
export type CollectionCreateInput = z.infer<typeof collectionCreateSchema>;

export const collectionUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    slug: slugSchema.optional(),
    description: z.string().trim().max(1000).optional(),
    is_published: z.boolean().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: "Provide at least one field to update." });
export type CollectionUpdateInput = z.infer<typeof collectionUpdateSchema>;

export const orderedLocationIdsSchema = z
  .object({ ordered_ids: z.array(uuid).min(1).max(500) })
  .strict()
  .refine((d) => new Set(d.ordered_ids).size === d.ordered_ids.length, {
    message: "ordered_ids must not contain duplicates.",
    path: ["ordered_ids"],
  });
export type OrderedLocationIdsInput = z.infer<typeof orderedLocationIdsSchema>;

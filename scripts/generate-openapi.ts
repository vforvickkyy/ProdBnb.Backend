/**
 * Generates docs/admin-openapi.json from the /v1/admin/* zod schemas.
 *
 * Scoped to the admin surface only (Phase 11) -- not retrofitted across the
 * other ~50 existing endpoints from Phases 1-8, which have no separate
 * frontend consumer that benefits from generated types the way the new
 * Admin Panel project does. Run via `npm run generate:openapi`.
 *
 * Response shapes (Phase 14) are hand-written zod schemas that mirror each
 * service's real TypeScript return type -- not derived from it, since those
 * types are plain hand-written interfaces, not zod-inferred. Keeping the two
 * in sync is a manual discipline (same as admin.schema.ts's own auditAction
 * enum already is, relative to audit.service.ts's AuditAction union): when a
 * service's returned shape changes, this file's matching schema must change
 * with it. This is what turns the Admin Panel's generated
 * src/types/admin-api.d.ts from `{ data?: unknown }` into real, checkable
 * response types for every endpoint.
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { extendZodWithOpenApi, OpenApiGeneratorV3, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { bookingActionSchema, bookingIdParamSchema, listBookingsQuerySchema } from "../src/modules/bookings/bookings.schema";
import { adminListLocationsQuerySchema, locationIdParamSchema } from "../src/modules/locations/locations.schema";
import { createRefundSchema, paymentIdParamSchema } from "../src/modules/payments/payment.schema";
import { listUsersQuerySchema } from "../src/modules/users/users.schema";
import {
  addDomainSchema,
  domainParamSchema,
  primaryDomainSchema,
  saveGoogleMapsSchema,
  saveVercelSchema,
  siteProviderParamSchema,
  siteProviderSchema,
  updateDomainSchema,
} from "../src/modules/site/site.schema";
import {
  createPageSchema,
  listSeoQuerySchema,
  pageIdParamSchema,
  pagePlacementSchema,
  saveSeoSchema,
  seoEntityTypeSchema,
  siteContactSchema,
  updatePageSchema,
} from "../src/modules/content/content.schema";
import {
  adminDeletionRequestsQuerySchema,
  adminRefundRequestsQuerySchema,
  approveRefundRequestSchema,
  completeDeletionSchema,
  declineSchema,
  deletionRequestStatusSchema,
  idParamSchema as accountIdParamSchema,
  refundRequestStatusSchema,
} from "../src/modules/account/account.schema";
import {
  adminHostRequestsQuerySchema,
  HOST_REQUEST_BEST_TIMES,
  HOST_REQUEST_STATUSES,
  hostRequestIdParamSchema,
  updateHostRequestSchema,
} from "../src/modules/hostRequests/hostRequests.schema";
import { earningStateSchema, hostIdParamSchema, listPayoutsQuerySchema, recordPayoutSchema } from "../src/modules/payouts/payouts.schema";
import { revealSchema } from "../src/modules/payouts/payouts.routes";
import { EMAIL_TEMPLATES } from "../src/modules/email/templates";
import { adminCreateCouponSchema, couponIdParamSchema, listCouponsQuerySchema, updateCouponSchema } from "../src/modules/coupons/coupons.schema";
import {
  invoiceIdParamSchema,
  invoicePreviewSchema,
  invoiceSettingsSchema,
  listInvoicesQuerySchema,
  listReceiptsQuerySchema,
  paymentIdParamSchema as receiptPaymentIdParamSchema,
  sendSchema as invoiceSendSchema,
} from "../src/modules/invoices/invoices.schema";
import {
  addTeamMemberSchema,
  adminConversationsQuerySchema,
  adminListPaymentsQuerySchema,
  adminListRefundsQuerySchema,
  adminUpdateLocationSchema,
  adminUserIdParamSchema,
  analyticsQuerySchema,
  attentionQuerySchema,
  auditActionSchema,
  auditLogQuerySchema,
  auditTargetTypeSchema,
  catalogItemParamSchema,
  catalogKindParamSchema,
  catalogNameSchema,
  catalogUpdateSchema,
  catalogListingParamSchema,
  catalogListingsQuerySchema,
  collectionCreateSchema,
  collectionIdParamSchema,
  collectionListingParamSchema,
  collectionUpdateSchema,
  coverCompleteSchema,
  coverUploadRequestSchema,
  adminCreateLocationSchema,
  hostSearchQuerySchema,
  locationIdsSchema,
  orderedLocationIdsSchema,
  conversationIdParamSchema,
  deliveryAttemptsQuerySchema,
  integrationsQuerySchema,
  locationMediaParamSchema,
  locationSectionParamSchema,
  messageAccessLogQuerySchema,
  noBodySchema,
  openConversationSchema,
  optionalReasonSchema,
  rejectLocationSchema,
  setTeamRoleSchema,
  suspendLocationSchema,
  suspendUserSchema,
  teamRoleSchema,
  teamUserIdParamSchema,
  updateSettingsSchema,
  userRoleParamSchema,
} from "../src/modules/admin/admin.schema";
import { ADMIN_PERMISSIONS } from "../src/modules/admin/permissions";
import {
  audiencePreviewSchema,
  audienceSchema,
  campaignChannelSchema,
  campaignIdParamSchema,
  campaignRecipientsQuerySchema,
  emailDesignSchema,
  channelEnabledSchema,
  channelNameSchema,
  channelParamSchema,
  createCampaignSchema,
  createTemplateSchema,
  jobsConfigSchema,
  PROFESSIONS,
  renderPreviewSchema,
  templateCategorySchema,
  templateIdParamSchema,
  updateTemplateSchema,
  listCampaignsQuerySchema,
  pushPlatformSchema,
  saveChannelSchema,
  sendCampaignSchema,
  testCampaignSchema,
  testChannelSchema,
  updateCampaignSchema,
} from "../src/modules/outreach/outreach.schema";
import {
  createFeatureFlagSchema,
  createIncidentSchema,
  createReleaseSchema,
  flagIdParamSchema,
  incidentIdParamSchema,
  platformParamSchema,
  releaseIdParamSchema,
  updateFeatureFlagSchema,
  updateIncidentSchema,
  updatePlatformSchema,
  updateReleaseSchema,
} from "../src/modules/platform/releases.schema";

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "Supabase access token",
});

const security = [{ bearerAuth: [] }];
const errorResponses = {
  "400": { description: "Validation error" },
  "401": { description: "Missing/invalid bearer token" },
  "403": { description: "Authenticated but not an admin" },
  "404": { description: "Not found" },
};

function jsonBody(schema: z.ZodTypeAny) {
  return { content: { "application/json": { schema } }, required: true };
}

function okResponse(dataSchema: z.ZodTypeAny) {
  return { description: "OK", content: { "application/json": { schema: z.object({ data: dataSchema }) } } };
}

function createdResponse(dataSchema: z.ZodTypeAny) {
  return { description: "Created", content: { "application/json": { schema: z.object({ data: dataSchema }) } } };
}

const paginationMeta = z.object({ page: z.number().int(), pageSize: z.number().int(), total: z.number().int() });

function paginatedResponse(itemSchema: z.ZodTypeAny) {
  return {
    description: "OK",
    content: { "application/json": { schema: z.object({ data: z.array(itemSchema), meta: paginationMeta }) } },
  };
}

// -- Shared field-level building blocks -------------------------------------

const nameRefSchema = z
  .object({ first_name: z.string().nullable(), last_name: z.string().nullable() })
  .nullable()
  .openapi("NameRef");

const catalogRefSchema = z.object({ id: z.string().uuid(), name: z.string() }).openapi("CatalogRef");

const amenityRefSchema = z
  .object({ id: z.string().uuid(), name: z.string(), group_name: z.string().nullable(), position: z.number().int() })
  .openapi("AmenityRef");

const listingPropSchema = z
  .object({
    name: z.string(),
    kind: z.enum(["included", "addon"]),
    price_minor_units: z.number().int().nullable(),
    price_unit: z.enum(["per_booking", "per_hour", "per_day"]).nullable(),
    note: z.string().nullable(),
  })
  .openapi("ListingProp");

/** The structured details a host or the team fills in (November 2026). */
const listingDetailShape = {
  /** The internal listing ID (HKLS01): only the host and the team get it. */
  listing_code: z.string().nullable(),
  area_sqft: z.number().int().nullable(),
  set_count: z.number().int().nullable(),
  parking_spaces: z.number().int().nullable(),
  restroom_count: z.number().int().nullable(),
  electricity: z.enum(["included", "extra", "not_available"]).nullable(),
  permission_needed: z.boolean().nullable(),
  permission_details: z.string().nullable(),
  custom_amenities: z.array(z.string()),
  custom_rules: z.array(z.string()),
  props: z.array(listingPropSchema),
};

const publicMediaItemSchema = z
  .object({
    id: z.string().uuid(),
    media_type: z.enum(["photo", "video"]),
    url: z.string().url(),
    position: z.number().int(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi("PublicMediaItem");

const bookingOptionSchema = z
  .object({ type: z.string(), amount_minor_units: z.number().int(), currency: z.string() })
  .openapi("BookingOption");

const hostPublicSummarySchema = z
  .object({
    id: z.string().uuid(),
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    avatar_url: z.string().nullable(),
  })
  .nullable()
  .openapi("HostPublicSummary");

// -- Dashboard ----------------------------------------------------------

const dashboardSummarySchema = z
  .object({
    total_users: z.number().int(),
    active_hosts: z.number().int(),
    published_locations: z.number().int(),
    locations_awaiting_approval: z.number().int(),
    upcoming_bookings: z.number().int(),
    recent_bookings: z.array(
      z.object({ id: z.string().uuid(), status: z.string(), start_at: z.string().datetime(), created_at: z.string().datetime() })
    ),
    payment_activity_30d: z.object({ count: z.number().int(), total_amount_minor_units: z.number().int() }),
    refund_activity_30d: z.object({ count: z.number().int(), total_amount_minor_units: z.number().int() }),
    recent_admin_actions: z.array(
      z.object({
        id: z.string().uuid(),
        action: z.string(),
        target_type: z.string(),
        target_id: z.string().uuid(),
        created_at: z.string().datetime(),
      })
    ),
    unpaid_holds: z.number().int(),
    payments_needing_attention: z.number().int(),
  })
  .openapi("DashboardSummary");

registry.registerPath({
  method: "get",
  path: "/dashboard",
  tags: ["Admin"],
  summary: "Operational dashboard summary",
  security,
  responses: { "200": okResponse(dashboardSummarySchema), ...errorResponses },
});

// -- System -----------------------------------------------------------------

const systemStatusSchema = z
  .object({
    environment: z.string(),
    payments: z.object({ provider: z.string(), mode: z.string() }),
    notifications: z.object({ provider: z.string() }),
    media: z.object({ configured: z.boolean() }),
  })
  .openapi("SystemStatus");

registry.registerPath({
  method: "get",
  path: "/system/status",
  tags: ["Admin", "System"],
  summary: "Provider/config status -- booleans and enums only, never a credential (Phase 14)",
  security,
  responses: { "200": okResponse(systemStatusSchema), ...errorResponses },
});

// -- Users --------------------------------------------------------------

const adminUserDetailSchema = z
  .object({
    id: z.string().uuid(),
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    avatar_url: z.string().nullable(),
    status: z.enum(["active", "suspended", "deleted"]),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    roles: z.array(z.enum(["booker", "host", "admin"])),
    email: z.string().nullable(),
    last_sign_in_at: z.string().datetime().nullable(),
    locations_count: z.number().int(),
    bookings_count: z.number().int(),
  })
  .openapi("AdminUserDetail");

// The detail view (and every mutation that returns a user) carries more than a list row does.
const adminUserFullDetailSchema = adminUserDetailSchema
  .extend({
    team_role: teamRoleSchema.nullable(),
    contact: z.object({
      phone: z.string().nullable(),
      address_line1: z.string().nullable(),
      address_line2: z.string().nullable(),
      address_city: z.string().nullable(),
      address_region: z.string().nullable(),
      address_country: z.string().nullable(),
      address_postal_code: z.string().nullable(),
    }),
    billing: z.object({ company_name: z.string().nullable(), gst_number: z.string().nullable(), updated_at: z.string().datetime() }).nullable(),
    preferences: z
      .object({
        professions: z.array(z.enum(PROFESSIONS)),
        company: z.string().nullable(),
        cities: z.array(z.string()),
        use_case_ids: z.array(z.string().uuid()),
        category_ids: z.array(z.string().uuid()),
        heard_from: z.string().nullable(),
        new_listing_alerts: z.boolean(),
        onboarding_completed_at: z.string().nullable(),
      })
      .openapi("UserPreferences"),
  })
  .openapi("AdminUserFullDetail");

registry.registerPath({
  method: "get",
  path: "/users",
  tags: ["Admin", "Users"],
  summary: "List users (search/role/status filters, roles included per row)",
  security,
  request: { query: listUsersQuerySchema },
  responses: { "200": paginatedResponse(adminUserDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/users/{id}",
  tags: ["Admin", "Users"],
  summary: "User detail: profile + roles + email (Admin Auth API) + counts",
  security,
  request: { params: adminUserIdParamSchema },
  responses: { "200": okResponse(adminUserFullDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/users/{id}/suspend",
  tags: ["Admin", "Users"],
  summary: "Suspend a user (reason required) -- cascades to their published locations only",
  security,
  request: { params: adminUserIdParamSchema, body: jsonBody(suspendUserSchema) },
  responses: { "200": okResponse(adminUserFullDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/users/{id}/restore",
  tags: ["Admin", "Users"],
  summary: "Restore a suspended user -- republishes only locations its own suspension put down",
  security,
  request: { params: adminUserIdParamSchema, body: jsonBody(noBodySchema) },
  responses: { "200": okResponse(adminUserFullDetailSchema), ...errorResponses },
});

// -- Locations ------------------------------------------------------------

const locationDetailSchema = z
  .object({
    id: z.string().uuid(),
    host_id: z.string().uuid(),
    title: z.string(),
    description: z.string(),
    address_line1: z.string().nullable(),
    address_line2: z.string().nullable(),
    city: z.string(),
    region: z.string().nullable(),
    country: z.string(),
    postal_code: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    capacity: z.number().int().nullable(),
    timezone: z.string(),
    instant_booking_enabled: z.boolean(),
    area: z.string().nullable(),
    public_latitude: z.number().nullable(),
    public_longitude: z.number().nullable(),
    show_exact_location: z.boolean(),
    price_on_request: z.boolean(),
    ...listingDetailShape,
    status: z.enum(["draft", "submitted", "under_review", "approved", "published", "rejected", "suspended", "archived"]),
    moderation_reason: z.string().nullable(),
    suspended_by_host_suspension: z.boolean(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    categories: z.array(catalogRefSchema),
    amenities: z.array(amenityRefSchema),
    rules: z.array(amenityRefSchema),
    use_cases: z.array(catalogRefSchema),
    media: z.array(publicMediaItemSchema),
    host: hostPublicSummarySchema,
    booking_options: z.array(bookingOptionSchema),
    bookable_options: z.array(z.object({ type: z.string(), half_day_duration_hours: z.number().int().nullable().optional() })),
    location_precision: z.enum(["exact", "approximate"]),
    approximate_radius_m: z.number().int().nullable(),
  })
  .openapi("LocationDetail");

const startingPriceSchema = z
  .object({ amount_minor_units: z.number().int(), currency: z.string(), booking_type: z.string() })
  .nullable()
  .openapi("StartingPrice");

const adminLocationListItemSchema = z
  .object({
    id: z.string().uuid(),
    host_id: z.string().uuid(),
    title: z.string(),
    description: z.string(),
    address_line1: z.string().nullable(),
    address_line2: z.string().nullable(),
    city: z.string(),
    region: z.string().nullable(),
    country: z.string(),
    postal_code: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    capacity: z.number().int().nullable(),
    timezone: z.string(),
    instant_booking_enabled: z.boolean(),
    area: z.string().nullable(),
    public_latitude: z.number().nullable(),
    public_longitude: z.number().nullable(),
    show_exact_location: z.boolean(),
    price_on_request: z.boolean(),
    ...listingDetailShape,
    status: z.enum(["draft", "submitted", "under_review", "approved", "published", "rejected", "suspended", "archived"]),
    moderation_reason: z.string().nullable(),
    suspended_by_host_suspension: z.boolean(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    cover_url: z.string().nullable(),
    media_count: z.number().int(),
    host: z.object({ id: z.string().uuid(), first_name: z.string().nullable(), last_name: z.string().nullable() }).nullable(),
    starting_price: startingPriceSchema,
  })
  .openapi("AdminLocationListItem");


registry.registerPath({
  method: "get",
  path: "/locations",
  tags: ["Admin", "Locations"],
  summary: "List locations (status/host_id/search filters)",
  security,
  request: { query: adminListLocationsQuerySchema },
  responses: { "200": paginatedResponse(adminLocationListItemSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/locations/{id}",
  tags: ["Admin", "Locations"],
  summary: "Location detail (includes moderation_reason, suspended_by_host_suspension)",
  security,
  request: { params: locationIdParamSchema },
  responses: { "200": okResponse(locationDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/locations/{id}/approve",
  tags: ["Admin", "Locations"],
  summary: "Approve: submitted/under_review -> published directly",
  security,
  request: { params: locationIdParamSchema, body: jsonBody(noBodySchema) },
  responses: { "200": okResponse(locationDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/locations/{id}/reject",
  tags: ["Admin", "Locations"],
  summary: "Reject (reason required): submitted/under_review -> rejected",
  security,
  request: { params: locationIdParamSchema, body: jsonBody(rejectLocationSchema) },
  responses: { "200": okResponse(locationDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/locations/{id}/suspend",
  tags: ["Admin", "Locations"],
  summary: "Suspend (reason required): published -> suspended",
  security,
  request: { params: locationIdParamSchema, body: jsonBody(suspendLocationSchema) },
  responses: { "200": okResponse(locationDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/locations/{id}/restore",
  tags: ["Admin", "Locations"],
  summary: "Restore: suspended -> published",
  security,
  request: { params: locationIdParamSchema, body: jsonBody(noBodySchema) },
  responses: { "200": okResponse(locationDetailSchema), ...errorResponses },
});

// -- Bookings ---------------------------------------------------------------

const bookingLocationRefSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  city: z.string(),
  region: z.string().nullable(),
  timezone: z.string(),
  host_id: z.string().uuid(),
  host: nameRefSchema,
  primary_media_url: z.string().nullable(),
});

const paymentSummarySchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  amount_minor_units: z.number().int(),
  created_at: z.string().datetime(),
});

const bookingDetailSchema = z
  .object({
    id: z.string().uuid(),
    location: bookingLocationRefSchema,
    booker_id: z.string().uuid(),
    booker: nameRefSchema,
    booking_type: z.enum(["hourly", "half_day", "day", "multi_day"]),
    start_at: z.string().datetime(),
    end_at: z.string().datetime(),
    status: z.enum(["requested", "confirmed", "cancelled", "completed", "rejected"]),
    pricing: z.object({
      base_amount_minor_units: z.number().int(),
      platform_fee_minor_units: z.number().int(),
      tax_minor_units: z.number().int(),
      discount_minor_units: z.number().int(),
      total_amount_minor_units: z.number().int(),
      currency: z.string(),
    }),
    payments: z.array(paymentSummarySchema),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    cancelled_at: z.string().datetime().nullable(),
    cancelled_by: z.string().uuid().nullable(),
    cancellation_reason: z.string().nullable(),
    hold_expired_at: z.string().datetime().nullable(),
    shoot: z
      .object({
        type_id: z.string().uuid().nullable(),
        type: z.string().nullable(),
        crew_size: z.number().int().nullable(),
        project_name: z.string().nullable(),
        production_name: z.string().nullable(),
        notes: z.string().nullable(),
        terms_accepted_at: z.string().datetime().nullable(),
      })
      .openapi("BookingShootDetails"),
    pricing_status: z.enum(["priced", "awaiting_quote", "quoted"]),
    quoted_at: z.string().datetime().nullable(),
  })
  .openapi("BookingDetail");

// Admin booking reads add when an unpaid active booking's hold lapses (null when paid, inactive,
// or unpaid-hold expiry is off).
const adminBookingSchema = bookingDetailSchema.extend({ hold_expires_at: z.string().datetime().nullable() }).openapi("AdminBooking");

registry.registerPath({
  method: "get",
  path: "/bookings",
  tags: ["Admin", "Bookings"],
  summary: "List bookings (booker_id/host_id/location_id/status/start_after/start_before filters)",
  security,
  request: { query: listBookingsQuerySchema },
  responses: { "200": paginatedResponse(adminBookingSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/bookings/{id}",
  tags: ["Admin", "Bookings"],
  summary: "Booking detail",
  security,
  request: { params: bookingIdParamSchema },
  responses: { "200": okResponse(adminBookingSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/bookings/{id}/cancel",
  tags: ["Admin", "Bookings"],
  summary: "Cancel a booking via the existing, unmodified booking engine",
  security,
  request: { params: bookingIdParamSchema, body: jsonBody(bookingActionSchema) },
  responses: { "200": okResponse(bookingDetailSchema), ...errorResponses },
});

// -- Payments / refunds -----------------------------------------------------

const bookingContextSchema = z
  .object({
    id: z.string().uuid(),
    location_id: z.string().uuid(),
    booker_id: z.string().uuid(),
    location: z.object({ title: z.string() }).nullable(),
    booker: nameRefSchema,
  })
  .nullable();

const adminPaymentDetailSchema = z
  .object({
    id: z.string().uuid(),
    booking_id: z.string().uuid(),
    provider: z.string(),
    provider_order_id: z.string(),
    provider_reference_id: z.string().nullable(),
    status: z.enum(["created", "pending", "success", "failed", "cancelled", "refunded", "partially_refunded"]),
    amount_minor_units: z.number().int(),
    currency: z.string(),
    failure_reason: z.string().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    booking: bookingContextSchema,
  })
  .openapi("AdminPaymentDetail");

const adminRefundDetailSchema = z
  .object({
    id: z.string().uuid(),
    payment_id: z.string().uuid(),
    provider_refund_id: z.string(),
    provider_reference_id: z.string().nullable(),
    status: z.enum(["pending", "success", "failed", "cancelled"]),
    amount_minor_units: z.number().int(),
    reason: z.string().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    payment: z.object({ id: z.string().uuid(), booking: bookingContextSchema }).nullable(),
  })
  .openapi("AdminRefundDetail");

registry.registerPath({
  method: "get",
  path: "/payments",
  tags: ["Admin", "Payments"],
  summary: "List payments (status/provider/booking_id/created_after/created_before filters)",
  security,
  request: { query: adminListPaymentsQuerySchema },
  responses: { "200": paginatedResponse(adminPaymentDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/payments/{id}",
  tags: ["Admin", "Payments"],
  summary: "Payment detail",
  security,
  request: { params: paymentIdParamSchema },
  responses: { "200": okResponse(adminPaymentDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/refunds",
  tags: ["Admin", "Payments"],
  summary: "List refunds (status/payment_id filters)",
  security,
  request: { query: adminListRefundsQuerySchema },
  responses: { "200": paginatedResponse(adminRefundDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/payments/{id}/refunds",
  tags: ["Admin", "Payments"],
  summary: "Create a refund via the existing PaymentService/PaymentProvider architecture",
  security,
  request: { params: paymentIdParamSchema, body: jsonBody(createRefundSchema) },
  responses: { "201": createdResponse(adminRefundDetailSchema.omit({ payment: true })), ...errorResponses },
});

// -- Notifications ------------------------------------------------------

const deliveryAttemptDeviceSchema = z
  .object({
    platform: z.string(),
    environment: z.string().nullable(),
    is_active: z.boolean(),
  })
  .nullable()
  .openapi("DeliveryAttemptDevice");

const deliveryAttemptRowSchema = z
  .object({
    id: z.string().uuid(),
    notification_id: z.string().uuid(),
    device_id: z.string().uuid(),
    provider: z.string(),
    status: z.enum(["sent", "failed", "invalid_token", "skipped"]),
    provider_message_id: z.string().nullable(),
    error_reason: z.string().nullable(),
    created_at: z.string().datetime(),
    device: deliveryAttemptDeviceSchema,
  })
  .openapi("DeliveryAttemptRow");

registry.registerPath({
  method: "get",
  path: "/notifications/delivery-attempts",
  tags: ["Admin", "Notifications"],
  summary: "Delivery diagnostics only (status/provider/error_reason) -- never notification content",
  security,
  request: { query: deliveryAttemptsQuerySchema },
  responses: { "200": paginatedResponse(deliveryAttemptRowSchema), ...errorResponses },
});

// -- Audit log ------------------------------------------------------------

const auditLogEntrySchema = z
  .object({
    id: z.string().uuid(),
    admin_id: z.string().uuid(),
    action: auditActionSchema,
    target_type: auditTargetTypeSchema,
    target_id: z.string().uuid(),
    reason: z.string().nullable(),
    metadata: z.record(z.unknown()),
    created_at: z.string().datetime(),
  })
  .openapi("AuditLogEntry");

registry.registerPath({
  method: "get",
  path: "/audit-log",
  tags: ["Admin", "Audit"],
  summary: "Immutable audit log (target_type/target_id/admin_id/action/created_after/created_before filters) -- no write endpoint exists",
  security,
  request: { query: auditLogQuerySchema },
  responses: { "200": paginatedResponse(auditLogEntrySchema), ...errorResponses },
});

// ============================================================================
// Admin Console
// ============================================================================

const permissionSchema = z.enum(ADMIN_PERMISSIONS);

// -- Me & team ------------------------------------------------------------------

const adminMeSchema = z
  .object({
    user_id: z.string().uuid(),
    email: z.string().nullable(),
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    team_role: teamRoleSchema,
    permissions: z.array(permissionSchema),
  })
  .openapi("AdminMe");

registry.registerPath({
  method: "get",
  path: "/me",
  tags: ["Admin", "Team"],
  summary: "The calling admin: team role and the exact permissions it grants",
  security,
  responses: { "200": okResponse(adminMeSchema), ...errorResponses },
});

const teamMemberSchema = z
  .object({
    user_id: z.string().uuid(),
    team_role: teamRoleSchema,
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    avatar_url: z.string().nullable(),
    status: z.string(),
    email: z.string().nullable(),
    created_by: z.string().uuid().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi("TeamMember");

registry.registerPath({
  method: "get",
  path: "/team",
  tags: ["Admin", "Team"],
  summary: "Every admin and their team role",
  security,
  responses: { "200": okResponse(z.array(teamMemberSchema)), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/team",
  tags: ["Admin", "Team"],
  summary: "Add an existing account to the admin team by email (super admin)",
  security,
  request: { body: jsonBody(addTeamMemberSchema) },
  responses: { "201": createdResponse(teamMemberSchema), ...errorResponses },
});

registry.registerPath({
  method: "put",
  path: "/team/{userId}",
  tags: ["Admin", "Team"],
  summary: "Set a team role (super admin). The last super admin cannot be demoted (409).",
  security,
  request: { params: teamUserIdParamSchema, body: jsonBody(setTeamRoleSchema) },
  responses: { "200": okResponse(teamMemberSchema), ...errorResponses },
});

registry.registerPath({
  method: "delete",
  path: "/team/{userId}",
  tags: ["Admin", "Team"],
  summary: "Remove from the admin team (super admin). Booker/host roles are kept.",
  security,
  request: { params: teamUserIdParamSchema },
  responses: { "200": okResponse(z.object({ removed: z.boolean() })), ...errorResponses },
});

// -- Settings -------------------------------------------------------------------

const platformSettingsSchema = z
  .object({
    id: z.string().uuid(),
    platform_fee_bps: z.number().int(),
    tax_bps: z.number().int(),
    unpaid_hold_minutes: z.number().int().nullable(),
    availability_requires_login: z.boolean(),
    /** Listing IDs: prefix (HKLS), digits (2 -> 01) and the number the next new listing gets. */
    listing_id_prefix: z.string(),
    listing_id_digits: z.number().int(),
    listing_id_next: z.number().int(),
    updated_by: z.string().uuid().nullable(),
    updated_at: z.string().datetime(),
  })
  .openapi("PlatformSettings");

registry.registerPath({
  method: "get",
  path: "/settings",
  tags: ["Admin", "Settings"],
  summary: "Platform fee, tax, unpaid-hold window and whether availability needs a login",
  security,
  responses: { "200": okResponse(platformSettingsSchema), ...errorResponses },
});

registry.registerPath({
  method: "patch",
  path: "/settings",
  tags: ["Admin", "Settings"],
  summary: "Change platform settings (super admin). Applies to new bookings only; audited.",
  security,
  request: { body: jsonBody(updateSettingsSchema) },
  responses: { "200": okResponse(platformSettingsSchema), ...errorResponses },
});

// -- Integrations ------------------------------------------------------------------

const integrationSettingSchema = z
  .object({
    key: z.string(),
    kind: z.enum(["secret", "identifier", "public"]),
    set: z.boolean(),
    display: z.string().nullable(),
  })
  .openapi("IntegrationSetting");

const integrationStatusSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    purpose: z.string(),
    status: z.enum(["ok", "warning", "error", "disabled", "unchecked"]),
    detail: z.string(),
    latency_ms: z.number().int().nullable(),
    settings: z.array(integrationSettingSchema),
  })
  .openapi("IntegrationStatus");

const integrationsReportSchema = z
  .object({
    checked_at: z.string().datetime(),
    live_checks: z.boolean(),
    deployment: z.object({
      node_env: z.string(),
      vercel_env: z.string().nullable(),
      region: z.string().nullable(),
      commit_sha: z.string().nullable(),
      commit_ref: z.string().nullable(),
      commit_message: z.string().nullable(),
      deployment_url: z.string().nullable(),
    }),
    integrations: z.array(integrationStatusSchema),
  })
  .openapi("IntegrationsReport");

registry.registerPath({
  method: "get",
  path: "/system/integrations",
  tags: ["Admin", "System"],
  summary: "Every integration's configuration status (never a secret value); ?check=true runs live checks",
  security,
  request: { query: integrationsQuerySchema },
  responses: { "200": okResponse(integrationsReportSchema), ...errorResponses },
});

// -- Analytics ----------------------------------------------------------------------

const analyticsSchema = z
  .object({
    range: z.object({ from: z.string(), to: z.string(), bucket: z.string(), timezone: z.string(), currency: z.string() }),
    totals: z.object({
      new_users: z.number().int(),
      new_listings: z.number().int(),
      published_listings: z.number().int(),
      bookings_created: z.number().int(),
      bookings_paid: z.number().int(),
      gmv_minor: z.number().int(),
      refunds_minor: z.number().int(),
      platform_fee_minor: z.number().int(),
      payment_success_rate: z.number().nullable(),
      cancellations: z.number().int(),
      expired_holds: z.number().int(),
      other_currency_payments: z.number().int(),
    }),
    series: z.array(
      z.object({
        bucket_start: z.string(),
        new_users: z.number().int(),
        bookings_created: z.number().int(),
        bookings_paid: z.number().int(),
        gmv_minor: z.number().int(),
      })
    ),
    status_breakdown: z.record(z.number().int()),
    booking_type_breakdown: z.record(z.number().int()),
    top_locations: z.array(
      z.object({ id: z.string().uuid(), title: z.string(), city: z.string(), paid_bookings: z.number().int(), gmv_minor: z.number().int() })
    ),
    top_cities: z.array(z.object({ city: z.string(), bookings: z.number().int() })),
  })
  .openapi("Analytics");

registry.registerPath({
  method: "get",
  path: "/analytics",
  tags: ["Admin", "Analytics"],
  summary: "Marketplace analytics for a range (bucketed by day/week/month in the given time zone)",
  security,
  request: { query: analyticsQuerySchema },
  responses: { "200": okResponse(analyticsSchema), ...errorResponses },
});

// -- People ---------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/users/{id}/roles/{role}",
  tags: ["Admin", "Users"],
  summary: "Grant booker/host on a user's behalf (audited). 'admin' is the team API's job.",
  security,
  request: { params: userRoleParamSchema },
  responses: { "201": createdResponse(adminUserFullDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "delete",
  path: "/users/{id}/roles/{role}",
  tags: ["Admin", "Users"],
  summary: "Revoke booker/host (audited). Existing listings are not touched.",
  security,
  request: { params: userRoleParamSchema },
  responses: { "200": okResponse(adminUserFullDetailSchema), ...errorResponses },
});

// -- Listing moderation -------------------------------------------------------------------

registry.registerPath({
  method: "patch",
  path: "/locations/{id}",
  tags: ["Admin", "Locations"],
  summary: "Correct a listing's content (not status). Audited with the fields changed.",
  security,
  request: { params: locationIdParamSchema, body: jsonBody(adminUpdateLocationSchema) },
  responses: { "200": okResponse(locationDetailSchema), ...errorResponses },
});

const sectionSummarySchema = z
  .object({
    id: z.string().uuid(),
    location_id: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    cover: publicMediaItemSchema.nullable(),
    photo_count: z.number().int(),
  })
  .openapi("LocationSectionSummary");

registry.registerPath({
  method: "get",
  path: "/locations/{id}/gallery",
  tags: ["Admin", "Locations"],
  summary: "Every photo on a listing: the general gallery and each section's",
  security,
  request: { params: locationIdParamSchema },
  responses: {
    "200": okResponse(
      z
        .object({
          general: z.array(publicMediaItemSchema),
          sections: z.array(z.object({ section: sectionSummarySchema, media: z.array(publicMediaItemSchema) })),
        })
        .openapi("LocationGallery")
    ),
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/locations/{id}/media/{mediaId}/remove",
  tags: ["Admin", "Locations"],
  summary: "Remove a photo/video from a listing (deletes the stored object; audited)",
  security,
  request: { params: locationMediaParamSchema, body: jsonBody(optionalReasonSchema) },
  responses: { "200": okResponse(z.object({ deleted: z.boolean() })), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/locations/{id}/sections/{sectionId}/remove",
  tags: ["Admin", "Locations"],
  summary: "Remove an empty section from a listing (audited)",
  security,
  request: { params: locationSectionParamSchema, body: jsonBody(optionalReasonSchema) },
  responses: { "200": okResponse(z.object({ deleted: z.boolean() })), ...errorResponses },
});

// -- Catalog --------------------------------------------------------------------------------

const adminCatalogItemSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable(),
    cover_url: z.string().nullable(),
    created_at: z.string().datetime(),
    usage_count: z.number().int(),
    /** Amenities only: a tick-box feature or a house rule, its group heading and its order. */
    kind: z.enum(["amenity", "rule"]).optional(),
    group_name: z.string().nullable().optional(),
    position: z.number().int().optional(),
  })
  .openapi("AdminCatalogItem");

registry.registerPath({
  method: "get",
  path: "/catalog/{kind}",
  tags: ["Admin", "Catalog"],
  summary: "Categories / amenities / use-cases, with how many listings use each",
  security,
  request: { params: catalogKindParamSchema },
  responses: { "200": okResponse(z.array(adminCatalogItemSchema)), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/catalog/{kind}",
  tags: ["Admin", "Catalog"],
  summary: "Add a catalog option (audited; duplicate names are 409)",
  security,
  request: { params: catalogKindParamSchema, body: jsonBody(catalogNameSchema) },
  responses: { "201": createdResponse(adminCatalogItemSchema), ...errorResponses },
});

registry.registerPath({
  method: "patch",
  path: "/catalog/{kind}/{itemId}",
  tags: ["Admin", "Catalog"],
  summary: "Rename / describe a catalog option (audited)",
  security,
  request: { params: catalogItemParamSchema, body: jsonBody(catalogUpdateSchema) },
  responses: { "200": okResponse(adminCatalogItemSchema), ...errorResponses },
});

registry.registerPath({
  method: "delete",
  path: "/catalog/{kind}/{itemId}",
  tags: ["Admin", "Catalog"],
  summary: "Delete an unused catalog option (409 while any listing uses it; audited)",
  security,
  request: { params: catalogItemParamSchema },
  responses: { "200": okResponse(z.object({ deleted: z.boolean() })), ...errorResponses },
});

// -- Booking actions --------------------------------------------------------------------------

for (const [action, summary, body] of [
  ["confirm", "Confirm on the host's behalf (audited)", noBodySchema],
  ["reject", "Reject on the host's behalf, optional reason (audited)", bookingActionSchema],
  ["complete", "Mark completed (audited)", noBodySchema],
] as const) {
  registry.registerPath({
    method: "post",
    path: `/bookings/{id}/${action}`,
    tags: ["Admin", "Bookings"],
    summary,
    security,
    request: { params: bookingIdParamSchema, body: jsonBody(body) },
    responses: { "200": okResponse(bookingDetailSchema), ...errorResponses },
  });
}

// -- Payments ---------------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/payments/{id}/verify",
  tags: ["Admin", "Payments"],
  summary: "Re-check a payment with the provider (same guarded path as the webhook; audited)",
  security,
  request: { params: paymentIdParamSchema, body: jsonBody(noBodySchema) },
  responses: { "200": okResponse(adminPaymentDetailSchema.omit({ booking: true })), ...errorResponses },
});

const paymentNeedingAttentionSchema = adminPaymentDetailSchema
  .extend({
    booking_status: z.string(),
    hold_expired: z.boolean(),
    cancelled_at: z.string().datetime().nullable(),
    refunded_minor_units: z.number().int(),
  })
  .openapi("PaymentNeedingAttention");

registry.registerPath({
  method: "get",
  path: "/payments/attention",
  tags: ["Admin", "Payments"],
  summary: "Money taken for a cancelled/rejected booking and not yet fully refunded",
  security,
  request: { query: attentionQuerySchema },
  responses: { "200": paginatedResponse(paymentNeedingAttentionSchema), ...errorResponses },
});

// -- Dispute message access ---------------------------------------------------------------------

const personRefSchema = z.object({ id: z.string().uuid(), first_name: z.string().nullable(), last_name: z.string().nullable() });

const adminConversationSummarySchema = z
  .object({
    id: z.string().uuid(),
    booker: personRefSchema,
    host: personRefSchema.nullable(),
    location: z.object({ id: z.string().uuid(), title: z.string(), city: z.string() }).nullable(),
    booking_id: z.string().uuid().nullable(),
    message_count: z.number().int(),
    last_message_at: z.string().datetime(),
    created_at: z.string().datetime(),
  })
  .openapi("AdminConversationSummary");

registry.registerPath({
  method: "get",
  path: "/conversations",
  tags: ["Admin", "Messaging"],
  summary: "Find conversations -- metadata only, never message text",
  security,
  request: { query: adminConversationsQuerySchema },
  responses: { "200": paginatedResponse(adminConversationSummarySchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/conversations/{id}/access",
  tags: ["Admin", "Messaging"],
  summary: "Read a conversation for a stated reason. Writes a permanent access record first.",
  security,
  request: { params: conversationIdParamSchema, body: jsonBody(openConversationSchema) },
  responses: {
    "200": okResponse(
      z
        .object({
          conversation: adminConversationSummarySchema,
          messages: z.array(
            z.object({
              id: z.string().uuid(),
              sender_id: z.string().uuid(),
              sender_role: z.enum(["booker", "host", "other"]),
              body: z.string(),
              created_at: z.string().datetime(),
            })
          ),
          truncated: z.boolean(),
          access_id: z.string().uuid(),
        })
        .openapi("AdminConversationTranscript")
    ),
    ...errorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/message-access-log",
  tags: ["Admin", "Messaging"],
  summary: "Every admin read of private correspondence, with its reason (append-only)",
  security,
  request: { query: messageAccessLogQuerySchema },
  responses: {
    "200": paginatedResponse(
      z
        .object({
          id: z.string().uuid(),
          admin_user_id: z.string().uuid(),
          admin: nameRefSchema,
          conversation_id: z.string().uuid(),
          action: z.string(),
          reason: z.string(),
          created_at: z.string().datetime(),
        })
        .openapi("MessageAccessLogEntry")
    ),
    ...errorResponses,
  },
});

// ================================================================================================
// Admin Console 2 -- listings for hosts, catalog covers + listings, collections, messaging, platforms
// ================================================================================================

const locationCardSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    city: z.string(),
    region: z.string().nullable(),
    country: z.string(),
    status: z.string(),
    host_id: z.string().uuid(),
    cover_url: z.string().nullable(),
    starting_price: startingPriceSchema,
  })
  .openapi("LocationCard");

registry.registerPath({
  method: "post",
  path: "/locations",
  tags: ["Admin", "Locations"],
  summary: "Create a listing owned by a host (optionally granting the host role; draft or published; audited)",
  security,
  request: { body: jsonBody(adminCreateLocationSchema) },
  responses: { "201": createdResponse(locationDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/hosts/search",
  tags: ["Admin", "Locations"],
  summary: "Find people by name or email for the host picker (hosts first)",
  security,
  request: { query: hostSearchQuerySchema },
  responses: {
    "200": okResponse(
      z.array(
        z
          .object({
            id: z.string().uuid(),
            first_name: z.string().nullable(),
            last_name: z.string().nullable(),
            email: z.string().nullable(),
            status: z.string(),
            is_host: z.boolean(),
            location_count: z.number().int(),
          })
          .openapi("HostCandidate")
      )
    ),
    ...errorResponses,
  },
});

const coverUploadAuthorizationSchema = z
  .object({
    upload_url: z.string().url(),
    storage_key: z.string(),
    expires_at: z.string().datetime(),
    method: z.literal("PUT"),
    headers: z.record(z.string()),
  })
  .openapi("CoverUploadAuthorization");

registry.registerPath({
  method: "post",
  path: "/catalog/{kind}/{itemId}/cover/upload",
  tags: ["Admin", "Catalog"],
  summary: "Presigned PUT for a catalog cover image (then PUT .../cover with the storage_key)",
  security,
  request: { params: catalogItemParamSchema, body: jsonBody(coverUploadRequestSchema) },
  responses: { "201": createdResponse(coverUploadAuthorizationSchema), ...errorResponses },
});
registry.registerPath({
  method: "put",
  path: "/catalog/{kind}/{itemId}/cover",
  tags: ["Admin", "Catalog"],
  summary: "Set the uploaded image as the cover (verified in R2; audited)",
  security,
  request: { params: catalogItemParamSchema, body: jsonBody(coverCompleteSchema) },
  responses: { "200": okResponse(adminCatalogItemSchema), ...errorResponses },
});
registry.registerPath({
  method: "delete",
  path: "/catalog/{kind}/{itemId}/cover",
  tags: ["Admin", "Catalog"],
  summary: "Remove the cover image (audited)",
  security,
  request: { params: catalogItemParamSchema },
  responses: { "200": okResponse(adminCatalogItemSchema), ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/catalog/{kind}/{itemId}/listings",
  tags: ["Admin", "Catalog"],
  summary: "Listings tagged with this category / amenity / use case",
  security,
  request: { params: catalogItemParamSchema, query: catalogListingsQuerySchema },
  responses: { "200": paginatedResponse(locationCardSchema), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/catalog/{kind}/{itemId}/listings",
  tags: ["Admin", "Catalog"],
  summary: "Tag listings with this item (idempotent; audited)",
  security,
  request: { params: catalogItemParamSchema, body: jsonBody(locationIdsSchema) },
  responses: { "200": okResponse(z.object({ added: z.number().int() })), ...errorResponses },
});
registry.registerPath({
  method: "delete",
  path: "/catalog/{kind}/{itemId}/listings/{locationId}",
  tags: ["Admin", "Catalog"],
  summary: "Untag one listing (audited)",
  security,
  request: { params: catalogListingParamSchema },
  responses: { "200": okResponse(z.object({ removed: z.boolean() })), ...errorResponses },
});

const collectionSummarySchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    slug: z.string(),
    description: z.string(),
    cover_url: z.string().nullable(),
    is_published: z.boolean(),
    position: z.number().int(),
    listing_count: z.number().int(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi("CollectionSummary");
const collectionDetailSchema = collectionSummarySchema.extend({ listings: z.array(locationCardSchema) }).openapi("CollectionDetail");

registry.registerPath({
  method: "get",
  path: "/collections",
  tags: ["Admin", "Collections"],
  summary: "All collections, published or not",
  security,
  responses: { "200": okResponse(z.array(collectionSummarySchema)), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/collections",
  tags: ["Admin", "Collections"],
  summary: "Create a collection (slug unique; audited)",
  security,
  request: { body: jsonBody(collectionCreateSchema) },
  responses: { "201": createdResponse(collectionDetailSchema), ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/collections/{collectionId}",
  tags: ["Admin", "Collections"],
  summary: "Collection with its ordered listings",
  security,
  request: { params: collectionIdParamSchema },
  responses: { "200": okResponse(collectionDetailSchema), ...errorResponses },
});
registry.registerPath({
  method: "patch",
  path: "/collections/{collectionId}",
  tags: ["Admin", "Collections"],
  summary: "Edit / publish / unpublish (audited)",
  security,
  request: { params: collectionIdParamSchema, body: jsonBody(collectionUpdateSchema) },
  responses: { "200": okResponse(collectionDetailSchema), ...errorResponses },
});
registry.registerPath({
  method: "delete",
  path: "/collections/{collectionId}",
  tags: ["Admin", "Collections"],
  summary: "Delete a collection (listings themselves are untouched; audited)",
  security,
  request: { params: collectionIdParamSchema },
  responses: { "200": okResponse(z.object({ deleted: z.boolean() })), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/collections/{collectionId}/cover/upload",
  tags: ["Admin", "Collections"],
  summary: "Presigned PUT for the collection cover",
  security,
  request: { params: collectionIdParamSchema, body: jsonBody(coverUploadRequestSchema) },
  responses: { "201": createdResponse(coverUploadAuthorizationSchema), ...errorResponses },
});
registry.registerPath({
  method: "put",
  path: "/collections/{collectionId}/cover",
  tags: ["Admin", "Collections"],
  summary: "Set the uploaded cover",
  security,
  request: { params: collectionIdParamSchema, body: jsonBody(coverCompleteSchema) },
  responses: { "200": okResponse(collectionDetailSchema), ...errorResponses },
});
registry.registerPath({
  method: "delete",
  path: "/collections/{collectionId}/cover",
  tags: ["Admin", "Collections"],
  summary: "Remove the cover",
  security,
  request: { params: collectionIdParamSchema },
  responses: { "200": okResponse(collectionDetailSchema), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/collections/{collectionId}/listings",
  tags: ["Admin", "Collections"],
  summary: "Append listings (existing ones are kept in place)",
  security,
  request: { params: collectionIdParamSchema, body: jsonBody(locationIdsSchema) },
  responses: { "200": okResponse(collectionDetailSchema), ...errorResponses },
});
registry.registerPath({
  method: "put",
  path: "/collections/{collectionId}/listings/order",
  tags: ["Admin", "Collections"],
  summary: "Replace the order (must list exactly the current listings)",
  security,
  request: { params: collectionIdParamSchema, body: jsonBody(orderedLocationIdsSchema) },
  responses: { "200": okResponse(collectionDetailSchema), ...errorResponses },
});
registry.registerPath({
  method: "delete",
  path: "/collections/{collectionId}/listings/{locationId}",
  tags: ["Admin", "Collections"],
  summary: "Remove one listing from the collection",
  security,
  request: { params: collectionListingParamSchema },
  responses: { "200": okResponse(collectionDetailSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/system/r2-cors",
  tags: ["Admin", "System"],
  summary: "Allow browser uploads: add an R2 CORS rule for CORS_ORIGINS (super admin; audited)",
  security,
  responses: { "200": okResponse(z.object({ rules: z.array(z.record(z.unknown())) })), ...errorResponses },
});

// -- Messaging --------------------------------------------------------------------------------

const channelStatusSchema = z
  .object({
    channel: channelNameSchema,
    connected: z.boolean(),
    source: z.enum(["dashboard", "environment"]).nullable(),
    enabled: z.boolean(),
    config: z.record(z.unknown()),
    last_tested_at: z.string().datetime().nullable(),
    last_test_ok: z.boolean().nullable(),
    last_test_error: z.string().nullable(),
    updated_at: z.string().datetime().nullable(),
  })
  .openapi("ChannelStatus");

const readinessSchema = z
  .object({ email: z.boolean(), push: z.object({ ios: z.boolean(), android: z.boolean(), web: z.boolean() }) })
  .openapi("ChannelReadiness");

const jobsStatusSchema = z
  .object({
    id: z.string().uuid(),
    dispatch_url: z.string().nullable(),
    enabled: z.boolean(),
    last_tick_at: z.string().datetime().nullable(),
    last_run_at: z.string().datetime().nullable(),
    last_run_ok: z.boolean().nullable(),
    last_run_summary: z.record(z.unknown()).nullable(),
    updated_at: z.string().datetime(),
    suggested_url: z.string(),
    health: z.object({ pg_net: z.boolean(), pg_cron: z.boolean(), dispatch_job_scheduled: z.boolean() }),
  })
  .openapi("JobsStatus");

const testResultSchema = z.object({ ok: z.boolean(), detail: z.string() }).openapi("ChannelTestResult");

registry.registerPath({
  method: "get",
  path: "/messaging/overview",
  tags: ["Admin", "Messaging"],
  summary: "Channels (status only, never secrets), readiness, active devices per platform, background jobs",
  security,
  responses: {
    "200": okResponse(
      z.object({
        channels: z.array(channelStatusSchema),
        readiness: readinessSchema,
        devices: z.object({ ios: z.number().int(), android: z.number().int(), web: z.number().int() }),
        jobs: jobsStatusSchema,
      })
    ),
    ...errorResponses,
  },
});
registry.registerPath({
  method: "put",
  path: "/messaging/channels/{channel}",
  tags: ["Admin", "Messaging"],
  summary: "Connect / update a channel. Secrets go to Vault and are never returned; blank keeps the stored one",
  security,
  request: { params: channelParamSchema, body: jsonBody(saveChannelSchema) },
  responses: { "200": okResponse(channelStatusSchema), ...errorResponses },
});
registry.registerPath({
  method: "patch",
  path: "/messaging/channels/{channel}",
  tags: ["Admin", "Messaging"],
  summary: "Pause / resume a connected channel",
  security,
  request: { params: channelParamSchema, body: jsonBody(channelEnabledSchema) },
  responses: { "200": okResponse(channelStatusSchema), ...errorResponses },
});
registry.registerPath({
  method: "delete",
  path: "/messaging/channels/{channel}",
  tags: ["Admin", "Messaging"],
  summary: "Disconnect a channel and delete its secret from Vault",
  security,
  request: { params: channelParamSchema },
  responses: { "200": okResponse(z.object({ removed: z.boolean() })), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/messaging/channels/{channel}/test",
  tags: ["Admin", "Messaging"],
  summary: "Test a channel: email to yourself, or push to your own devices (credential check when you have none)",
  security,
  request: { params: channelParamSchema, body: jsonBody(testChannelSchema) },
  responses: { "200": okResponse(testResultSchema), ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/messaging/jobs",
  tags: ["Admin", "Messaging"],
  summary: "Background job dispatch (scheduled sends) status",
  security,
  responses: { "200": okResponse(jobsStatusSchema), ...errorResponses },
});
registry.registerPath({
  method: "put",
  path: "/messaging/jobs",
  tags: ["Admin", "Messaging"],
  summary: "Enable background jobs / set the dispatch URL (audited)",
  security,
  request: { body: jsonBody(jobsConfigSchema) },
  responses: { "200": okResponse(jobsStatusSchema), ...errorResponses },
});

const campaignStatsSchema = z
  .object({
    total: z.number().int(),
    processed: z.number().int(),
    in_app_created: z.number().int(),
    push_sent: z.number().int(),
    push_failed: z.number().int(),
    push_no_devices: z.number().int(),
    push_opted_out: z.number().int(),
    email_sent: z.number().int(),
    email_failed: z.number().int(),
    email_unsubscribed: z.number().int(),
    email_missing: z.number().int(),
    email_delivered: z.number().int(),
    email_opened: z.number().int(),
    email_clicked: z.number().int(),
    email_bounced: z.number().int(),
    email_complained: z.number().int(),
  })
  .openapi("CampaignStats");

const campaignSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    kind: z.enum(["announcement", "direct"]),
    channels: z.array(campaignChannelSchema),
    platforms: z.array(pushPlatformSchema),
    audience: audienceSchema,
    title: z.string(),
    body: z.string(),
    link_url: z.string().nullable(),
    email_subject: z.string().nullable(),
    email_body: z.string().nullable(),
    location_id: z.string().uuid().nullable(),
    coupon_id: z.string().uuid().nullable(),
    template_id: z.string().uuid().nullable(),
    email_design: emailDesignSchema,
    email_heading: z.string().nullable(),
    email_image_url: z.string().nullable(),
    email_button_label: z.string().nullable(),
    email_location_ids: z.array(z.string().uuid()),
    status: z.enum(["draft", "scheduled", "sending", "sent", "cancelled", "failed"]),
    scheduled_at: z.string().datetime().nullable(),
    started_at: z.string().datetime().nullable(),
    completed_at: z.string().datetime().nullable(),
    recipient_count: z.number().int().nullable(),
    last_error: z.string().nullable(),
    created_by: z.string().uuid().nullable(),
    sent_by: z.string().uuid().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    stats: campaignStatsSchema,
  })
  .openapi("Campaign");

registry.registerPath({
  method: "get",
  path: "/campaigns",
  tags: ["Admin", "Messaging"],
  summary: "Announcements and direct notifications, newest first, with delivery stats",
  security,
  request: { query: listCampaignsQuerySchema },
  responses: { "200": paginatedResponse(campaignSchema), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/campaigns",
  tags: ["Admin", "Messaging"],
  summary: "Create a draft (push implies in-app)",
  security,
  request: { body: jsonBody(createCampaignSchema) },
  responses: { "201": createdResponse(campaignSchema), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/campaigns/audience-preview",
  tags: ["Admin", "Messaging"],
  summary: "How many people / emails / devices an audience reaches",
  security,
  request: { body: jsonBody(audiencePreviewSchema) },
  responses: {
    "200": okResponse(
      z
        .object({
          users: z.number().int(),
          with_email: z.number().int(),
          email: z.object({
            will_receive: z.number().int(),
            unsubscribed: z.number().int(),
            bounced: z.number().int(),
            no_email: z.number().int(),
          }),
          devices: z.object({ ios: z.number().int(), android: z.number().int(), web: z.number().int() }),
        })
        .openapi("AudiencePreview")
    ),
    ...errorResponses,
  },
});
registry.registerPath({
  method: "post",
  path: "/campaigns/test",
  tags: ["Admin", "Messaging"],
  summary: "Send the content to yourself only (your email and your own devices)",
  security,
  request: { body: jsonBody(testCampaignSchema) },
  responses: {
    "200": okResponse(
      z.object({
        push: z.object({ outcome: z.string(), sent: z.number().int(), failed: z.number().int() }).optional(),
        email: testResultSchema.optional(),
      })
    ),
    ...errorResponses,
  },
});
registry.registerPath({
  method: "get",
  path: "/campaigns/{campaignId}",
  tags: ["Admin", "Messaging"],
  summary: "One campaign with live stats",
  security,
  request: { params: campaignIdParamSchema },
  responses: { "200": okResponse(campaignSchema), ...errorResponses },
});
registry.registerPath({
  method: "patch",
  path: "/campaigns/{campaignId}",
  tags: ["Admin", "Messaging"],
  summary: "Edit a draft or scheduled campaign",
  security,
  request: { params: campaignIdParamSchema, body: jsonBody(updateCampaignSchema) },
  responses: { "200": okResponse(campaignSchema), ...errorResponses },
});
registry.registerPath({
  method: "delete",
  path: "/campaigns/{campaignId}",
  tags: ["Admin", "Messaging"],
  summary: "Delete a draft",
  security,
  request: { params: campaignIdParamSchema },
  responses: { "200": okResponse(z.object({ deleted: z.boolean() })), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/campaigns/{campaignId}/send",
  tags: ["Admin", "Messaging"],
  summary: "Send now (processes a first batch inline) or schedule (audited)",
  security,
  request: { params: campaignIdParamSchema, body: jsonBody(sendCampaignSchema) },
  responses: { "200": okResponse(campaignSchema), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/campaigns/{campaignId}/cancel",
  tags: ["Admin", "Messaging"],
  summary: "Stop a draft / scheduled / sending campaign (audited)",
  security,
  request: { params: campaignIdParamSchema },
  responses: { "200": okResponse(campaignSchema), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/campaigns/{campaignId}/process",
  tags: ["Admin", "Messaging"],
  summary: "Advance a sending campaign by one batch (the campaign page polls this)",
  security,
  request: { params: campaignIdParamSchema },
  responses: { "200": okResponse(campaignSchema), ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/campaigns/{campaignId}/recipients",
  tags: ["Admin", "Messaging"],
  summary: "Per-recipient delivery outcome",
  security,
  request: { params: campaignIdParamSchema, query: campaignRecipientsQuerySchema },
  responses: {
    "200": paginatedResponse(
      z
        .object({
          user_id: z.string().uuid(),
          email: z.string().nullable(),
          first_name: z.string().nullable(),
          last_name: z.string().nullable(),
          in_app_status: z.string(),
          push_status: z.string(),
          email_status: z.string(),
          push_sent: z.number().int(),
          push_failed: z.number().int(),
          error: z.string().nullable(),
          processed_at: z.string().datetime().nullable(),
          email_delivered_at: z.string().nullable(),
          email_opened_at: z.string().nullable(),
          email_clicked_at: z.string().nullable(),
          email_open_count: z.number().int(),
          email_click_count: z.number().int(),
          email_bounced_at: z.string().nullable(),
          email_complained_at: z.string().nullable(),
        })
        .openapi("CampaignRecipient")
    ),
    ...errorResponses,
  },
});

// -- Platforms --------------------------------------------------------------------------------

const appPlatformSchema = z
  .object({
    id: z.string().uuid(),
    platform: z.enum(["ios", "android", "web"]),
    display_name: z.string(),
    status: z.enum(["not_launched", "in_development", "beta", "live", "maintenance", "deprecated"]),
    live_version: z.string().nullable(),
    latest_version: z.string().nullable(),
    min_supported_version: z.string().nullable(),
    store_url: z.string().nullable(),
    update_message: z.string().nullable(),
    force_update_message: z.string().nullable(),
    maintenance_mode: z.boolean(),
    maintenance_message: z.string().nullable(),
    notes: z.string().nullable(),
    updated_by: z.string().uuid().nullable(),
    updated_at: z.string().datetime(),
  })
  .openapi("AppPlatform");

const flagTargetSchema = z.object({ enabled: z.boolean(), min_version: z.string().nullable().optional() });
const featureFlagSchema = z
  .object({
    id: z.string().uuid(),
    key: z.string(),
    name: z.string(),
    description: z.string(),
    targets: z.object({ ios: flagTargetSchema.optional(), android: flagTargetSchema.optional(), web: flagTargetSchema.optional() }),
    updated_at: z.string().datetime(),
  })
  .openapi("FeatureFlag");

const incidentSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    summary: z.string(),
    severity: z.enum(["minor", "major", "critical"]),
    status: z.enum(["investigating", "identified", "monitoring", "resolved"]),
    platforms: z.array(z.enum(["ios", "android", "web", "backend", "admin"])),
    is_public: z.boolean(),
    started_at: z.string().datetime(),
    resolved_at: z.string().datetime().nullable(),
    created_by: z.string().uuid().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    updates: z.array(
      z.object({
        id: z.string().uuid(),
        incident_id: z.string().uuid(),
        status: z.string(),
        message: z.string(),
        created_by: z.string().uuid().nullable(),
        created_at: z.string().datetime(),
      })
    ),
  })
  .openapi("PlatformIncident");

const releaseSchema = z
  .object({
    id: z.string().uuid(),
    platform: z.enum(["ios", "android", "web", "backend", "admin"]),
    version: z.string(),
    title: z.string(),
    notes: z.string(),
    status: z.enum(["planned", "in_progress", "in_review", "released", "cancelled"]),
    target_date: z.string().nullable(),
    released_at: z.string().datetime().nullable(),
    feature_keys: z.array(z.string()),
    created_by: z.string().uuid().nullable(),
    updated_by: z.string().uuid().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi("ReleasePlan");

const pushHealthBucket = z.object({ sent: z.number().int(), failed: z.number().int(), invalid_token: z.number().int(), skipped: z.number().int() });

registry.registerPath({
  method: "get",
  path: "/platforms",
  tags: ["Admin", "Platforms"],
  summary: "Platforms, feature flags, incidents, releases, versions in use and health signals",
  security,
  responses: {
    "200": okResponse(
      z
        .object({
          platforms: z.array(appPlatformSchema),
          feature_flags: z.array(featureFlagSchema),
          incidents: z.array(incidentSchema),
          releases: z.array(releaseSchema.omit({})),
          versions_in_use: z.array(
            z.object({
              platform: z.string(),
              app_version: z.string(),
              users: z.number().int(),
              devices: z.number().int(),
              last_seen: z.string().nullable(),
            })
          ),
          health: z.object({
            push_last_24h: z.record(pushHealthBucket),
            active_devices: z.object({ ios: z.number().int(), android: z.number().int(), web: z.number().int() }),
            backend: z.object({ environment: z.string(), commit: z.string().nullable(), region: z.string().nullable() }),
          }),
        })
        .openapi("PlatformsOverview")
    ),
    ...errorResponses,
  },
});
registry.registerPath({
  method: "patch",
  path: "/platforms/{platform}",
  tags: ["Admin", "Platforms"],
  summary: "Status, versions, update prompts, maintenance mode (super admin; audited)",
  security,
  request: { params: platformParamSchema, body: jsonBody(updatePlatformSchema) },
  responses: { "200": okResponse(appPlatformSchema), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/feature-flags",
  tags: ["Admin", "Platforms"],
  summary: "Create a feature flag",
  security,
  request: { body: jsonBody(createFeatureFlagSchema) },
  responses: { "201": createdResponse(featureFlagSchema), ...errorResponses },
});
registry.registerPath({
  method: "patch",
  path: "/feature-flags/{flagId}",
  tags: ["Admin", "Platforms"],
  summary: "Edit a feature flag's targets",
  security,
  request: { params: flagIdParamSchema, body: jsonBody(updateFeatureFlagSchema) },
  responses: { "200": okResponse(featureFlagSchema), ...errorResponses },
});
registry.registerPath({
  method: "delete",
  path: "/feature-flags/{flagId}",
  tags: ["Admin", "Platforms"],
  summary: "Delete a feature flag",
  security,
  request: { params: flagIdParamSchema },
  responses: { "200": okResponse(z.object({ deleted: z.boolean() })), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/incidents",
  tags: ["Admin", "Platforms"],
  summary: "Open an incident (public ones appear in /v1/app-config for the affected platforms)",
  security,
  request: { body: jsonBody(createIncidentSchema) },
  responses: { "201": createdResponse(incidentSchema.omit({ updates: true })), ...errorResponses },
});
registry.registerPath({
  method: "patch",
  path: "/incidents/{incidentId}",
  tags: ["Admin", "Platforms"],
  summary: "Update an incident; `message` adds a timeline entry",
  security,
  request: { params: incidentIdParamSchema, body: jsonBody(updateIncidentSchema) },
  responses: { "200": okResponse(incidentSchema.omit({ updates: true })), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/releases",
  tags: ["Admin", "Platforms"],
  summary: "Plan a release",
  security,
  request: { body: jsonBody(createReleaseSchema) },
  responses: { "201": createdResponse(releaseSchema), ...errorResponses },
});
registry.registerPath({
  method: "patch",
  path: "/releases/{releaseId}",
  tags: ["Admin", "Platforms"],
  summary: "Update a release; promote_to_live sets the platform's live/latest version when released",
  security,
  request: { params: releaseIdParamSchema, body: jsonBody(updateReleaseSchema) },
  responses: { "200": okResponse(releaseSchema), ...errorResponses },
});
registry.registerPath({
  method: "delete",
  path: "/releases/{releaseId}",
  tags: ["Admin", "Platforms"],
  summary: "Delete a release plan",
  security,
  request: { params: releaseIdParamSchema },
  responses: { "200": okResponse(z.object({ deleted: z.boolean() })), ...errorResponses },
});

// -- Website (Console 3) -------------------------------------------------------------------------

const siteIntegrationStatusSchema = z
  .object({
    provider: siteProviderSchema,
    connected: z.boolean(),
    config: z.record(z.unknown()),
    has_secret: z.boolean(),
    last_tested_at: z.string().datetime().nullable(),
    last_test_ok: z.boolean().nullable(),
    last_test_error: z.string().nullable(),
    updated_at: z.string().datetime().nullable(),
  })
  .openapi("SiteIntegrationStatus");

const dnsRecordSchema = z
  .object({ type: z.enum(["A", "CNAME", "TXT"]), name: z.string(), value: z.string(), purpose: z.enum(["point", "verify"]) })
  .openapi("DnsRecord");

const siteDomainSchema = z
  .object({
    name: z.string(),
    apex_name: z.string(),
    is_apex: z.boolean(),
    is_platform_domain: z.boolean(),
    is_primary: z.boolean(),
    verified: z.boolean(),
    redirect_to: z.string().nullable(),
    configured: z.boolean().nullable(),
    configured_by: z.string().nullable(),
    dns_records: z.array(dnsRecordSchema),
    status: z.enum(["active", "redirect", "pending_dns", "pending_verification"]),
  })
  .openapi("SiteDomain");

const siteDomainsOverviewSchema = z
  .object({ vercel_connected: z.boolean(), primary_domain: z.string().nullable(), domains: z.array(siteDomainSchema) })
  .openapi("SiteDomainsOverview");

registry.registerPath({
  method: "get",
  path: "/site/integrations",
  tags: ["Admin", "Website"],
  summary: "Website integrations (Google Maps, Vercel): status and safe configuration only, never secrets",
  security,
  responses: { "200": okResponse(z.array(siteIntegrationStatusSchema)), ...errorResponses },
});
registry.registerPath({
  method: "put",
  path: "/site/integrations/google_maps",
  tags: ["Admin", "Website"],
  summary: "Connect Google Maps. The browser key is public by design; the optional server key goes to Vault",
  security,
  request: { body: jsonBody(saveGoogleMapsSchema) },
  responses: { "200": okResponse(siteIntegrationStatusSchema), ...errorResponses },
});
registry.registerPath({
  method: "put",
  path: "/site/integrations/vercel",
  tags: ["Admin", "Website"],
  summary: "Connect the website's Vercel project (token goes to Vault; checked against the project first)",
  security,
  request: { body: jsonBody(saveVercelSchema) },
  responses: { "200": okResponse(siteIntegrationStatusSchema), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/site/integrations/{provider}/test",
  tags: ["Admin", "Website"],
  summary: "Test a website integration",
  security,
  request: { params: siteProviderParamSchema },
  responses: { "200": okResponse(z.object({ ok: z.boolean(), detail: z.string() })), ...errorResponses },
});
registry.registerPath({
  method: "delete",
  path: "/site/integrations/{provider}",
  tags: ["Admin", "Website"],
  summary: "Disconnect a website integration and delete its secret from Vault",
  security,
  request: { params: siteProviderParamSchema },
  responses: { "200": okResponse(z.object({ removed: z.boolean() })), ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/site/domains",
  tags: ["Admin", "Website"],
  summary: "The website's domains, their status and the DNS records each still needs",
  security,
  responses: { "200": okResponse(siteDomainsOverviewSchema), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/site/domains",
  tags: ["Admin", "Website"],
  summary: "Add a domain to the website (optionally redirecting to another of its domains)",
  security,
  request: { body: jsonBody(addDomainSchema) },
  responses: { "201": createdResponse(siteDomainSchema), ...errorResponses },
});
registry.registerPath({
  method: "patch",
  path: "/site/domains/{domain}",
  tags: ["Admin", "Website"],
  summary: "Set or clear a domain's redirect",
  security,
  request: { params: domainParamSchema, body: jsonBody(updateDomainSchema) },
  responses: { "200": okResponse(siteDomainSchema), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/site/domains/{domain}/verify",
  tags: ["Admin", "Website"],
  summary: "Re-check a domain's ownership verification and DNS",
  security,
  request: { params: domainParamSchema },
  responses: { "200": okResponse(siteDomainSchema), ...errorResponses },
});
registry.registerPath({
  method: "delete",
  path: "/site/domains/{domain}",
  tags: ["Admin", "Website"],
  summary: "Remove a domain from the website (not the primary one, not the platform address)",
  security,
  request: { params: domainParamSchema },
  responses: { "200": okResponse(z.object({ removed: z.boolean() })), ...errorResponses },
});
registry.registerPath({
  method: "put",
  path: "/site/primary-domain",
  tags: ["Admin", "Website"],
  summary: "Choose the primary domain (canonical URLs, sitemaps). Must be verified, configured and not redirecting",
  security,
  request: { body: jsonBody(primaryDomainSchema) },
  responses: { "200": okResponse(siteDomainsOverviewSchema), ...errorResponses },
});

// -- Website pages and SEO -------------------------------------------------------------------------

const sitePageSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    title: z.string(),
    body: z.string().openapi({ description: "Markdown. May contain {{brand}} and {{support_email}}." }),
    placement: pagePlacementSchema,
    position: z.number().int(),
    is_published: z.boolean(),
    needs_review: z.boolean(),
    placeholders: z.array(z.string()).openapi({ description: 'Bracketed placeholders still in the text, e.g. "[Company legal name]".' }),
    updated_by: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("SitePage");

const seoOverrideSchema = z
  .object({
    id: z.string().uuid(),
    entity_type: seoEntityTypeSchema,
    entity_key: z.string(),
    meta_title: z.string().nullable(),
    meta_description: z.string().nullable(),
    og_image_url: z.string().nullable(),
    noindex: z.boolean(),
    updated_by: z.string().uuid().nullable(),
    updated_at: z.string(),
  })
  .openapi("SeoOverride");

const seoKeyParamsDoc = z.object({
  type: seoEntityTypeSchema,
  key: z.string().openapi({ description: "Page slug (or home, host, shoots) for type=page; the entity's id otherwise." }),
});

const siteSettingsSchema = z
  .object({ id: z.string().uuid(), primary_domain: z.string().nullable(), support_email: z.string().nullable(), updated_at: z.string() })
  .openapi("SiteSettings");

registry.registerPath({
  method: "get",
  path: "/site/contact",
  tags: ["Admin", "Website"],
  summary: "The website's contact email (shown in the footer and on pages)",
  security,
  responses: { "200": okResponse(siteSettingsSchema), ...errorResponses },
});
registry.registerPath({
  method: "put",
  path: "/site/contact",
  tags: ["Admin", "Website"],
  summary: "Set or clear the website's contact email (content.manage)",
  security,
  request: { body: jsonBody(siteContactSchema) },
  responses: { "200": okResponse(siteSettingsSchema), ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/site/pages",
  tags: ["Admin", "Website"],
  summary: "Every website page, drafts included",
  security,
  responses: { "200": okResponse(z.array(sitePageSchema)), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/site/pages",
  tags: ["Admin", "Website"],
  summary: "Create a website page (content.manage)",
  security,
  request: { body: jsonBody(createPageSchema) },
  responses: { "201": createdResponse(sitePageSchema), "409": { description: "Address already used" }, ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/site/pages/{id}",
  tags: ["Admin", "Website"],
  summary: "One website page",
  security,
  request: { params: pageIdParamSchema },
  responses: { "200": okResponse(sitePageSchema), ...errorResponses },
});
registry.registerPath({
  method: "patch",
  path: "/site/pages/{id}",
  tags: ["Admin", "Website"],
  summary: "Edit, publish or unpublish a website page (content.manage)",
  security,
  request: { params: pageIdParamSchema, body: jsonBody(updatePageSchema) },
  responses: { "200": okResponse(sitePageSchema), "409": { description: "Address already used" }, ...errorResponses },
});
registry.registerPath({
  method: "delete",
  path: "/site/pages/{id}",
  tags: ["Admin", "Website"],
  summary: "Delete a website page and its SEO override (content.manage)",
  security,
  request: { params: pageIdParamSchema },
  responses: { "200": okResponse(z.object({ removed: z.boolean() })), ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/site/seo",
  tags: ["Admin", "Website"],
  summary: "SEO overrides, optionally of one type",
  security,
  request: { query: listSeoQuerySchema },
  responses: { "200": okResponse(z.array(seoOverrideSchema)), ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/site/seo/{type}/{key}",
  tags: ["Admin", "Website"],
  summary: "One SEO override, or null when the website writes it automatically",
  security,
  request: { params: seoKeyParamsDoc },
  responses: { "200": okResponse(seoOverrideSchema.nullable()), ...errorResponses },
});
registry.registerPath({
  method: "put",
  path: "/site/seo/{type}/{key}",
  tags: ["Admin", "Website"],
  summary: "Save an SEO override (content.manage). Omitted fields are kept; null clears; an empty override is deleted",
  security,
  request: { params: seoKeyParamsDoc, body: jsonBody(saveSeoSchema) },
  responses: { "200": okResponse(seoOverrideSchema.nullable()), ...errorResponses },
});

// -- Booker account: refund requests and account deletion ------------------------------------------

const refundRequestSchema = z
  .object({
    id: z.string().uuid(),
    booking_id: z.string().uuid(),
    payment_id: z.string().uuid(),
    source: z.enum(["booker", "cancellation", "rejection"]),
    reason: z.string().nullable(),
    status: refundRequestStatusSchema,
    approved_amount_minor_units: z.number().int().nullable(),
    refund_id: z.string().uuid().nullable(),
    decided_at: z.string().nullable(),
    decision_note: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("RefundRequest");

const adminRefundRequestSchema = refundRequestSchema
  .extend({
    booking: z
      .object({
        id: z.string().uuid(),
        status: z.string(),
        start_at: z.string(),
        end_at: z.string(),
        cancellation_reason: z.string().nullable(),
        location: z.object({ id: z.string().uuid(), title: z.string(), city: z.string().nullable() }).nullable(),
        booker: z.object({ id: z.string().uuid(), first_name: z.string().nullable(), last_name: z.string().nullable() }).nullable(),
      })
      .nullable(),
    payment: z
      .object({ id: z.string().uuid(), amount_minor_units: z.number().int(), currency: z.string(), status: z.string(), method: z.string().nullable() })
      .nullable(),
    refunded_minor_units: z.number().int(),
    remaining_minor_units: z.number().int(),
  })
  .openapi("AdminRefundRequest");

const deletionBlockersSchema = z.object({ upcoming_bookings: z.number().int(), upcoming_hosted_bookings: z.number().int() });

const adminDeletionRequestSchema = z
  .object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    reason: z.string().nullable(),
    status: deletionRequestStatusSchema,
    decided_at: z.string().nullable(),
    decision_note: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    user: z.object({ id: z.string().uuid(), first_name: z.string().nullable(), last_name: z.string().nullable(), status: z.string() }).nullable(),
    email: z.string().nullable(),
    blockers: deletionBlockersSchema.nullable(),
  })
  .openapi("AdminDeletionRequest");

registry.registerPath({
  method: "get",
  path: "/refund-requests",
  tags: ["Admin", "Payments"],
  summary: "Refund requests from bookers (payments.view). Pending ones oldest first",
  security,
  request: { query: adminRefundRequestsQuerySchema },
  responses: { "200": paginatedResponse(adminRefundRequestSchema), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/refund-requests/{id}/approve",
  tags: ["Admin", "Payments"],
  summary: "Approve a refund request (payments.refund): refunds through the provider, full or partial",
  security,
  request: { params: accountIdParamSchema, body: jsonBody(approveRefundRequestSchema) },
  responses: { "200": okResponse(refundRequestSchema), "409": { description: "Already decided, or being decided" }, ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/refund-requests/{id}/decline",
  tags: ["Admin", "Payments"],
  summary: "Decline a refund request with a note the booker sees (payments.refund)",
  security,
  request: { params: accountIdParamSchema, body: jsonBody(declineSchema) },
  responses: { "200": okResponse(refundRequestSchema), "409": { description: "Already decided, or being decided" }, ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/deletion-requests",
  tags: ["Admin", "Users"],
  summary: "Account deletion requests (users.view), with what still blocks each one",
  security,
  request: { query: adminDeletionRequestsQuerySchema },
  responses: { "200": paginatedResponse(adminDeletionRequestSchema), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/deletion-requests/{id}/complete",
  tags: ["Admin", "Users"],
  summary: "Complete a deletion (users.manage): anonymise the profile, archive listings, lock sign-in. Records are kept",
  security,
  request: { params: accountIdParamSchema, body: jsonBody(completeDeletionSchema) },
  responses: { "200": okResponse(adminDeletionRequestSchema.omit({ user: true, email: true, blockers: true })), "409": { description: "Upcoming bookings, or already decided" }, ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/deletion-requests/{id}/decline",
  tags: ["Admin", "Users"],
  summary: "Decline a deletion request with a note (users.manage)",
  security,
  request: { params: accountIdParamSchema, body: jsonBody(declineSchema) },
  responses: { "200": okResponse(adminDeletionRequestSchema.omit({ user: true, email: true, blockers: true })), ...errorResponses },
});

// -- Host callback requests ("Request a callback" from would-be hosts) -----------------------------

const adminHostRequestSchema = z
  .object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    location_id: z.string().uuid().nullable(),
    name: z.string(),
    phone: z.string(),
    email: z.string().nullable(),
    city: z.string().nullable(),
    space_type: z.string().nullable(),
    best_time: z.enum(HOST_REQUEST_BEST_TIMES),
    note: z.string().nullable(),
    source: z.enum(["ios", "android", "web"]),
    status: z.enum(HOST_REQUEST_STATUSES),
    contacted_at: z.string().nullable(),
    closed_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    admin_notes: z.string().nullable(),
    handled_by: z.string().uuid().nullable(),
    user: z.object({ id: z.string().uuid(), first_name: z.string().nullable(), last_name: z.string().nullable(), status: z.string() }).nullable(),
    listing: z
      .object({ id: z.string().uuid(), title: z.string(), status: z.string(), listing_code: z.string().nullable(), city: z.string().nullable() })
      .nullable(),
    handler: z.object({ id: z.string().uuid(), first_name: z.string().nullable(), last_name: z.string().nullable() }).nullable(),
  })
  .openapi("AdminHostRequest");

registry.registerPath({
  method: "get",
  path: "/host-requests",
  tags: ["Admin", "Users"],
  summary: "Callback requests from people who want to list a place (host_requests.manage). Waiting ones oldest first",
  security,
  request: { query: adminHostRequestsQuerySchema },
  responses: { "200": paginatedResponse(adminHostRequestSchema), ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/host-requests/summary",
  tags: ["Admin", "Users"],
  summary: "How many callback requests are new and contacted (host_requests.manage)",
  security,
  responses: { "200": okResponse(z.object({ new: z.number().int(), contacted: z.number().int() })), ...errorResponses },
});
registry.registerPath({
  method: "patch",
  path: "/host-requests/{id}",
  tags: ["Admin", "Users"],
  summary: "Move a callback request along (New, Contacted, Done, Closed) and keep the team's notes (host_requests.manage)",
  security,
  request: { params: hostRequestIdParamSchema, body: jsonBody(updateHostRequestSchema) },
  responses: { "200": okResponse(adminHostRequestSchema), "409": { description: "Withdrawn by the person, or they have another open request" }, ...errorResponses },
});

// -- Email log (transactional emails) -------------------------------------------------------------

const emailStatusSchema = z.enum(["queued", "sending", "sent", "failed", "skipped"]);
const adminEmailSchema = z
  .object({
    id: z.string().uuid(),
    user_id: z.string().uuid().nullable(),
    to_email: z.string(),
    template: z.enum(EMAIL_TEMPLATES),
    stream: z.enum(["transactional", "marketing"]),
    idempotency_key: z.string(),
    data: z.record(z.unknown()),
    subject: z.string().nullable(),
    status: emailStatusSchema,
    attempts: z.number().int(),
    last_error: z.string().nullable(),
    provider_message_id: z.string().nullable(),
    send_after: z.string(),
    sent_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("AdminEmail");

registry.registerPath({
  method: "get",
  path: "/emails",
  tags: ["Admin", "Messaging"],
  summary: "Transactional emails sent or waiting (campaigns.view), newest first",
  security,
  request: {
    query: z.object({
      status: emailStatusSchema.optional(),
      template: z.enum(EMAIL_TEMPLATES).optional(),
      search: z.string().optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }),
  },
  responses: { "200": paginatedResponse(adminEmailSchema), ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/emails/summary",
  tags: ["Admin", "Messaging"],
  summary: "How many emails are in each state over the last 7 days (campaigns.view)",
  security,
  responses: { "200": okResponse(z.record(emailStatusSchema, z.number().int())), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/emails/{id}/resend",
  tags: ["Admin", "Messaging"],
  summary: "Send an email again (campaigns.send)",
  security,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: { "200": okResponse(adminEmailSchema), ...errorResponses },
});

const emailSuppressionSchema = z
  .object({
    email: z.string(),
    reason: z.enum(["unsubscribed", "bounced", "admin"]),
    user_id: z.string().uuid().nullable(),
    created_at: z.string(),
  })
  .openapi("AdminEmailSuppression");

registry.registerPath({
  method: "get",
  path: "/emails/suppressions",
  tags: ["Admin", "Messaging"],
  summary: "Addresses we don't email: bounced (nothing is sent) or unsubscribed from news and offers (campaigns.view)",
  security,
  request: {
    query: z.object({
      reason: z.enum(["unsubscribed", "bounced", "admin"]).optional(),
      search: z.string().optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }),
  },
  responses: { "200": paginatedResponse(emailSuppressionSchema), ...errorResponses },
});
registry.registerPath({
  method: "delete",
  path: "/emails/suppressions/{email}",
  tags: ["Admin", "Messaging"],
  summary: "Unblock an address (campaigns.send)",
  security,
  request: { params: z.object({ email: z.string().email() }) },
  responses: { "200": okResponse(z.object({ removed: z.boolean() })), ...errorResponses },
});

const emailSubscriberSchema = z
  .object({
    user_id: z.string().uuid(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    roles: z.array(z.string()),
    status: z.enum(["subscribed", "unsubscribed", "bounced", "no_email"]),
    status_since: z.string().nullable(),
    joined_at: z.string(),
  })
  .openapi("EmailSubscriber");

registry.registerPath({
  method: "get",
  path: "/email-subscribers",
  tags: ["Admin", "Messaging"],
  summary: "Everyone, with whether news and offers reach them by email (campaigns.view)",
  security,
  request: {
    query: z.object({
      status: z.enum(["subscribed", "unsubscribed", "bounced", "no_email"]).optional(),
      role: z.enum(["booker", "host"]).optional(),
      search: z.string().optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }),
  },
  responses: { "200": paginatedResponse(emailSubscriberSchema), ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/email-subscribers/summary",
  tags: ["Admin", "Messaging"],
  summary: "How many people get news and offers by email (campaigns.view)",
  security,
  responses: {
    "200": okResponse(
      z.object({
        people: z.number().int(),
        subscribed: z.number().int(),
        unsubscribed: z.number().int(),
        bounced: z.number().int(),
        no_email: z.number().int(),
        hosts_subscribed: z.number().int(),
        bookers_subscribed: z.number().int(),
      })
    ),
    ...errorResponses,
  },
});

// -- Host payouts ---------------------------------------------------------------------------------

const payoutAccountSchema = z
  .object({
    account_holder_name: z.string(),
    account_last4: z.string(),
    ifsc: z.string(),
    bank_name: z.string().nullable(),
    pan_last4: z.string(),
    updated_at: z.string(),
  })
  .openapi("PayoutAccount");

const hostRefSchema = z.object({ id: z.string().uuid(), first_name: z.string().nullable(), last_name: z.string().nullable() });

const earningRowSchema = z
  .object({
    booking_id: z.string().uuid(),
    location: z.object({ id: z.string().uuid(), title: z.string(), city: z.string().nullable() }),
    booking_status: z.string(),
    booking_type: z.string(),
    start_at: z.string(),
    end_at: z.string(),
    currency: z.string(),
    listing_price_minor_units: z.number().int(),
    host_discount_minor_units: z.number().int(),
    paid_minor_units: z.number().int(),
    refunded_minor_units: z.number().int(),
    net_minor_units: z.number().int(),
    state: earningStateSchema,
    payout: z.object({ id: z.string().uuid(), paid_at: z.string(), reference: z.string() }).nullable(),
  })
  .openapi("EarningRow");

const earningsSummarySchema = z
  .object({
    currency: z.string(),
    upcoming_minor_units: z.number().int(),
    ready_minor_units: z.number().int(),
    on_hold_minor_units: z.number().int(),
    paid_minor_units: z.number().int(),
  })
  .openapi("EarningsSummary");

const payoutSchema = z
  .object({
    id: z.string().uuid(),
    host_id: z.string().uuid(),
    amount_minor_units: z.number().int(),
    currency: z.string(),
    reference: z.string(),
    paid_at: z.string(),
    note: z.string().nullable(),
    account_last4: z.string().nullable(),
    ifsc: z.string().nullable(),
    created_at: z.string(),
    booking_count: z.number().int(),
  })
  .openapi("Payout");

const hostDueSchema = z
  .object({
    host: hostRefSchema,
    ready_minor_units: z.number().int(),
    ready_bookings: z.number().int(),
    on_hold_minor_units: z.number().int(),
    currency: z.string(),
    account: payoutAccountSchema.nullable(),
  })
  .openapi("HostDue");

registry.registerPath({
  method: "get",
  path: "/payouts/due",
  tags: ["Admin", "Payments"],
  summary: "Hosts owed money now (ready) and on hold, largest first (payments.view)",
  security,
  responses: { "200": okResponse(z.array(hostDueSchema)), ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/payouts",
  tags: ["Admin", "Payments"],
  summary: "Payouts recorded, newest first (payments.view)",
  security,
  request: { query: listPayoutsQuerySchema },
  responses: { "200": paginatedResponse(payoutSchema), ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/hosts/{id}/earnings",
  tags: ["Admin", "Payments"],
  summary: "A host's earnings per booking, summary and masked payout details (payments.view)",
  security,
  request: { params: hostIdParamSchema },
  responses: {
    "200": okResponse(
      z.object({ host: hostRefSchema, account: payoutAccountSchema.nullable(), summary: earningsSummarySchema, rows: z.array(earningRowSchema) })
    ),
    ...errorResponses,
  },
});
registry.registerPath({
  method: "post",
  path: "/hosts/{id}/payout-account/reveal",
  tags: ["Admin", "Payments"],
  summary: "Full bank account number and PAN, to make a transfer (payments.refund). Audited",
  security,
  request: { params: hostIdParamSchema, body: jsonBody(revealSchema) },
  responses: { "200": okResponse(payoutAccountSchema.extend({ account_number: z.string(), pan: z.string() })), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/hosts/{id}/payouts",
  tags: ["Admin", "Payments"],
  summary: "Record a payout sent to a host for ready bookings (payments.refund). Each booking is paid once",
  security,
  request: { params: hostIdParamSchema, body: jsonBody(recordPayoutSchema) },
  responses: { "201": createdResponse(payoutSchema), "409": { description: "Booking already paid out" }, ...errorResponses },
});

// -- Coupons -------------------------------------------------------------------------------------

const couponSchema = z
  .object({
    id: z.string().uuid(),
    code: z.string(),
    owner_type: z.enum(["platform", "host"]),
    host_id: z.string().uuid().nullable(),
    host: hostRefSchema.nullable(),
    title: z.string(),
    description: z.string().nullable(),
    discount_type: z.enum(["percent", "fixed"]),
    percent_off: z.number().int().nullable(),
    amount_off_minor_units: z.number().int().nullable(),
    max_discount_minor_units: z.number().int().nullable(),
    min_booking_minor_units: z.number().int().nullable(),
    booking_types: z.array(z.string()).nullable(),
    starts_at: z.string().nullable(),
    ends_at: z.string().nullable(),
    usage_limit: z.number().int().nullable(),
    per_user_limit: z.number().int().nullable(),
    first_booking_only: z.boolean(),
    is_public: z.boolean(),
    is_active: z.boolean(),
    location_ids: z.array(z.string().uuid()),
    status: z.enum(["active", "scheduled", "ended", "inactive", "used_up"]),
    uses: z.number().int(),
    discount_given_minor_units: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("Coupon");

const redemptionSchema = z
  .object({
    id: z.string().uuid(),
    booking_id: z.string().uuid(),
    discount_minor_units: z.number().int(),
    funded_by: z.enum(["platform", "host"]),
    created_at: z.string(),
    booking: z.object({ status: z.string(), start_at: z.string(), paid: z.boolean(), location: z.object({ id: z.string().uuid(), title: z.string() }).nullable() }).nullable(),
    booker: z.object({ first_name: z.string().nullable(), last_name: z.string().nullable() }).nullable(),
  })
  .openapi("CouponRedemption");

registry.registerPath({
  method: "get",
  path: "/coupons",
  tags: ["Admin", "Coupons"],
  summary: "Every coupon (the platform's and hosts'), with status and uses (payments.view)",
  security,
  request: { query: listCouponsQuerySchema },
  responses: { "200": paginatedResponse(couponSchema), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/coupons",
  tags: ["Admin", "Coupons"],
  summary: "Create a platform coupon, or one on a host's behalf (coupons.manage). Audited",
  security,
  request: { body: jsonBody(adminCreateCouponSchema) },
  responses: { "201": createdResponse(couponSchema), "409": { description: "Code already taken" }, ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/coupons/{id}",
  tags: ["Admin", "Coupons"],
  summary: "A coupon with every booking that used it (payments.view)",
  security,
  request: { params: couponIdParamSchema },
  responses: { "200": okResponse(couponSchema.extend({ redemptions: z.array(redemptionSchema) })), ...errorResponses },
});
registry.registerPath({
  method: "patch",
  path: "/coupons/{id}",
  tags: ["Admin", "Coupons"],
  summary: "Edit, pause or resume a coupon (coupons.manage). Audited; bookings keep their discount",
  security,
  request: { params: couponIdParamSchema, body: jsonBody(updateCouponSchema) },
  responses: { "200": okResponse(couponSchema), ...errorResponses },
});
registry.registerPath({
  method: "delete",
  path: "/coupons/{id}",
  tags: ["Admin", "Coupons"],
  summary: "Delete a coupon nobody has used (coupons.manage). Audited",
  security,
  request: { params: couponIdParamSchema },
  responses: { "200": okResponse(z.object({ deleted: z.boolean() })), "409": { description: "Already used: turn it off instead" }, ...errorResponses },
});

// -- Invoices and receipts ---------------------------------------------------------------------------

const invoiceSettingsOutSchema = z
  .object({
    id: z.string().uuid(),
    legal_name: z.string().nullable(),
    trade_name: z.string().nullable(),
    gstin: z.string().nullable(),
    pan: z.string().nullable(),
    address_line1: z.string().nullable(),
    address_line2: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    state_code: z.string().nullable(),
    postal_code: z.string().nullable(),
    country: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    website: z.string().nullable(),
    number_prefix: z.string(),
    sac_code: z.string().nullable(),
    tax_label: z.string(),
    notes: z.string().nullable(),
    terms: z.string().nullable(),
    signatory: z.string().nullable(),
    auto_send: z.boolean(),
    updated_at: z.string(),
    missing: z.array(z.string()).openapi({ description: "What's still needed before invoices can be issued" }),
    email_connected: z.boolean(),
  })
  .openapi("InvoiceSettings");

const invoicePartySchema = z
  .object({
    name: z.string(),
    legal_name: z.string().nullable().optional(),
    company: z.string().nullable().optional(),
    gstin: z.string().nullable().optional(),
    pan: z.string().nullable().optional(),
    address: z.array(z.string()),
    state: z.string().nullable().optional(),
    state_code: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    website: z.string().nullable().optional(),
  })
  .openapi("InvoiceParty");

const invoiceSchema = z
  .object({
    id: z.string().uuid(),
    number: z.string(),
    fy: z.string(),
    booking_id: z.string().uuid(),
    payment_id: z.string().uuid().nullable(),
    user_id: z.string().uuid().nullable(),
    issued_at: z.string(),
    seller: invoicePartySchema,
    billed_to: invoicePartySchema,
    details: z.object({
      booking_ref: z.string(),
      listing: z.string(),
      city: z.string().nullable(),
      booking_type: z.string(),
      when: z.string(),
      payment_ref: z.string().nullable(),
      payment_method: z.string().nullable(),
      paid_at: z.string().nullable(),
    }),
    currency: z.string(),
    subtotal_minor_units: z.number().int(),
    discount_minor_units: z.number().int(),
    coupon_code: z.string().nullable(),
    service_fee_minor_units: z.number().int(),
    tax_minor_units: z.number().int(),
    tax_rate_bps: z.number().int().nullable(),
    total_minor_units: z.number().int(),
    tax_label: z.string(),
    sac_code: z.string().nullable(),
    delivery_status: z.enum(["pending", "sent", "failed"]),
    sent_via: z.enum(["auto", "manual"]).nullable(),
    sent_at: z.string().nullable(),
    sent_to: z.string().nullable(),
    send_count: z.number().int(),
    last_error: z.string().nullable(),
  })
  .openapi("Invoice");

const invoiceEventSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(["issued", "sent_auto", "sent_manual", "failed", "receipt_sent"]),
    to_email: z.string().nullable(),
    error: z.string().nullable(),
    created_at: z.string(),
    actor: nameRefSchema,
  })
  .openapi("InvoiceEvent");

const receiptSchema = z
  .object({
    payment_id: z.string().uuid(),
    booking_id: z.string().uuid(),
    amount_minor_units: z.number().int(),
    refunded_minor_units: z.number().int(),
    currency: z.string(),
    status: z.string(),
    method: z.string().nullable(),
    paid_at: z.string(),
    booker: z.object({ id: z.string().uuid(), first_name: z.string().nullable(), last_name: z.string().nullable() }).nullable(),
    listing: z.string().nullable(),
    invoice_number: z.string().nullable(),
    last_sent_at: z.string().nullable(),
  })
  .openapi("Receipt");

const pdfResponse = { description: "A PDF file", content: { "application/pdf": { schema: z.string().openapi({ format: "binary" }) } } };
const invoiceCountsSchema = z.object({
  all: z.number().int(),
  pending: z.number().int(),
  sent_auto: z.number().int(),
  sent_manual: z.number().int(),
  failed: z.number().int(),
  waiting: z.number().int().openapi({ description: "Paid bookings with no invoice yet" }),
});

registry.registerPath({
  method: "get",
  path: "/invoice-settings",
  tags: ["Admin", "Invoices"],
  summary: "The invoice template: company details, numbering, tax, notes (payments.view)",
  security,
  responses: { "200": okResponse(invoiceSettingsOutSchema), ...errorResponses },
});
registry.registerPath({
  method: "patch",
  path: "/invoice-settings",
  tags: ["Admin", "Invoices"],
  summary: "Update the invoice template (invoices.manage). Audited; issued invoices keep their details",
  security,
  request: { body: jsonBody(invoiceSettingsSchema) },
  responses: { "200": okResponse(invoiceSettingsOutSchema), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/invoice-settings/preview",
  tags: ["Admin", "Invoices"],
  summary: "A sample invoice PDF with the saved template plus unsaved edits (payments.view)",
  security,
  request: { body: jsonBody(invoicePreviewSchema) },
  responses: { "200": pdfResponse, ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/invoices",
  tags: ["Admin", "Invoices"],
  summary: "Invoices, filtered by delivery: pending, sent automatically, sent manually, failed (payments.view)",
  security,
  request: { query: listInvoicesQuerySchema },
  responses: {
    "200": {
      description: "OK",
      content: { "application/json": { schema: z.object({ data: z.array(invoiceSchema), meta: paginationMeta.extend({ counts: invoiceCountsSchema }) }) } },
    },
    ...errorResponses,
  },
});
registry.registerPath({
  method: "get",
  path: "/invoices/{id}",
  tags: ["Admin", "Invoices"],
  summary: "An invoice with its history (issued, sent, failed) (payments.view)",
  security,
  request: { params: invoiceIdParamSchema },
  responses: { "200": okResponse(invoiceSchema.extend({ events: z.array(invoiceEventSchema) })), ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/invoices/{id}/pdf",
  tags: ["Admin", "Invoices"],
  summary: "Download the invoice PDF (payments.view)",
  security,
  request: { params: invoiceIdParamSchema },
  responses: { "200": pdfResponse, ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/invoices/{id}/send",
  tags: ["Admin", "Invoices"],
  summary: "Email the invoice to the booker, or to another address (invoices.manage). Audited",
  security,
  request: { params: invoiceIdParamSchema, body: jsonBody(invoiceSendSchema) },
  responses: { "200": okResponse(invoiceSchema), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/invoices/issue-missing",
  tags: ["Admin", "Invoices"],
  summary: "Issue invoices for paid bookings that have none; they wait to be sent (invoices.manage). Audited",
  security,
  responses: { "200": okResponse(z.object({ issued: z.number().int() })), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/invoices/send-pending",
  tags: ["Admin", "Invoices"],
  summary: "Email every invoice that's pending or failed (invoices.manage). Audited",
  security,
  responses: { "200": okResponse(z.object({ sent: z.number().int(), failed: z.number().int() })), ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/receipts",
  tags: ["Admin", "Invoices"],
  summary: "Payment receipts: every settled payment (payments.view)",
  security,
  request: { query: listReceiptsQuerySchema },
  responses: { "200": paginatedResponse(receiptSchema), ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/receipts/{id}/pdf",
  tags: ["Admin", "Invoices"],
  summary: "Download a payment receipt PDF (payments.view)",
  security,
  request: { params: receiptPaymentIdParamSchema },
  responses: { "200": pdfResponse, ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/receipts/{id}/send",
  tags: ["Admin", "Invoices"],
  summary: "Email a payment receipt to the booker (invoices.manage). Audited",
  security,
  request: { params: receiptPaymentIdParamSchema, body: jsonBody(invoiceSendSchema) },
  responses: { "200": okResponse(z.object({ to: z.string() })), ...errorResponses },
});

// -- Notification templates and variables ------------------------------------------------------------

const notificationTemplateSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    category: templateCategorySchema,
    description: z.string().nullable(),
    needs: z.enum(["listing", "offer"]).nullable(),
    title: z.string(),
    body: z.string(),
    email_subject: z.string().nullable(),
    email_body: z.string().nullable(),
    channels: z.array(campaignChannelSchema),
    email_design: emailDesignSchema,
    email_heading: z.string().nullable(),
    email_image_url: z.string().nullable(),
    email_button_label: z.string().nullable(),
    is_builtin: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
    uses: z.number().int(),
  })
  .openapi("NotificationTemplate");

const notificationVariableSchema = z
  .object({ key: z.string(), label: z.string(), example: z.string(), scope: z.enum(["person", "listing", "offer"]) })
  .openapi("NotificationVariable");

registry.registerPath({
  method: "get",
  path: "/notification-templates",
  tags: ["Admin", "Messaging"],
  summary: "Notification templates (built-in and the team's own) (campaigns.view)",
  security,
  responses: { "200": okResponse(z.array(notificationTemplateSchema)), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/notification-templates",
  tags: ["Admin", "Messaging"],
  summary: "Create a template (campaigns.send). Unknown {variables} are refused. Audited",
  security,
  request: { body: jsonBody(createTemplateSchema) },
  responses: { "201": createdResponse(notificationTemplateSchema), ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/notification-templates/{templateId}",
  tags: ["Admin", "Messaging"],
  summary: "One template (campaigns.view)",
  security,
  request: { params: templateIdParamSchema },
  responses: { "200": okResponse(notificationTemplateSchema), ...errorResponses },
});
registry.registerPath({
  method: "patch",
  path: "/notification-templates/{templateId}",
  tags: ["Admin", "Messaging"],
  summary: "Edit a template, built-in ones included (campaigns.send). Audited",
  security,
  request: { params: templateIdParamSchema, body: jsonBody(updateTemplateSchema) },
  responses: { "200": okResponse(notificationTemplateSchema), ...errorResponses },
});
registry.registerPath({
  method: "delete",
  path: "/notification-templates/{templateId}",
  tags: ["Admin", "Messaging"],
  summary: "Delete one of the team's templates (campaigns.send). Built-in ones can't be deleted. Audited",
  security,
  request: { params: templateIdParamSchema },
  responses: { "200": okResponse(z.object({ deleted: z.boolean() })), "409": { description: "Built-in template" }, ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/notification-variables",
  tags: ["Admin", "Messaging"],
  summary: "Variables usable in notification text: per person ({first_name}), listing ({listing_title}) and offer ({offer_code})",
  security,
  responses: { "200": okResponse(z.array(notificationVariableSchema)), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/campaigns/render-preview",
  tags: ["Admin", "Messaging"],
  summary: "The text as one person gets it (the signed-in admin, or user_id), with the listing/offer filled in (campaigns.view)",
  security,
  request: { body: jsonBody(renderPreviewSchema) },
  responses: {
    "200": okResponse(
      z.object({
        title: z.string(),
        body: z.string(),
        link_url: z.string().nullable(),
        email_subject: z.string().nullable(),
        email_body: z.string().nullable(),
        user_id: z.string().uuid(),
        missing: z.array(z.string()).openapi({ description: "Person variables that person hasn't filled in (the fallback was used)" }),
        email_heading: z.string().nullable().optional(),
        email_button_label: z.string().nullable().optional(),
        email_html: z.string().nullable().openapi({ description: "The whole email as it will arrive (null when there's no email)" }),
        email_text: z.string().nullable(),
        email_problem: z.string().nullable().openapi({ description: "Why the email can't be built yet (e.g. the listing isn't published)" }),
      })
    ),
    ...errorResponses,
  },
});
registry.registerPath({
  method: "get",
  path: "/campaigns/audience-options",
  tags: ["Admin", "Messaging"],
  summary: "Choices for a segment audience (professions, cities, shoot types) with how many people each reaches (campaigns.view)",
  security,
  responses: {
    "200": okResponse(
      z.object({
        professions: z.array(z.object({ value: z.enum(PROFESSIONS), label: z.string(), count: z.number().int() })),
        cities: z.array(z.object({ name: z.string(), count: z.number().int() })),
        use_cases: z.array(z.object({ id: z.string().uuid(), name: z.string(), count: z.number().int() })),
        onboarded: z.number().int(),
      })
    ),
    ...errorResponses,
  },
});

// -- SMS (Messaging -> SMS) ---------------------------------------------------------------------------

const smsProviderIdSchema = z.enum(["msg91", "twilio", "twofactor", "gupshup"]);
const smsStatusSchema = z.enum(["queued", "sending", "sent", "delivered", "failed", "skipped"]);
const smsOverviewSchema = z
  .object({
    settings: z.object({
      mode: z.enum(["off", "test", "live"]),
      active_provider: smsProviderIdSchema.nullable(),
      sender_id: z.string().nullable(),
      dlt_entity_id: z.string().nullable(),
      test_numbers: z.array(z.string()),
      otp_per_hour: z.number().int(),
      updated_at: z.string(),
    }),
    providers: z.array(
      z.object({
        id: smsProviderIdSchema,
        name: z.string(),
        website: z.string(),
        connected: z.boolean(),
        active: z.boolean(),
        config: z.record(z.string()),
        fields: z.array(
          z.object({
            key: z.string(),
            label: z.string(),
            secret: z.boolean(),
            required: z.boolean(),
            placeholder: z.string().optional(),
            help: z.string().optional(),
            saved: z.boolean(),
          })
        ),
        report_setup: z.string(),
        last_tested_at: z.string().nullable(),
        last_test_ok: z.boolean().nullable(),
        last_test_error: z.string().nullable(),
      })
    ),
    report_urls: z.record(z.string()),
    sign_in_hook_ready: z.boolean(),
    sign_in_hook_url: z.string(),
    sign_in_hook_source: z.enum(["backend", "admin"]).nullable(),
  })
  .openapi("SmsOverview");
const smsPreviewSchema = z.object({ text: z.string(), encoding: z.string(), characters: z.number().int(), segments: z.number().int() });
const smsTemplateSchema = z
  .object({
    key: z.string(),
    name: z.string(),
    audience: z.enum(["booker", "host", "everyone"]),
    category: z.enum(["otp", "transactional", "service"]),
    body: z.string(),
    dlt_template_id: z.string().nullable(),
    provider_template_id: z.string().nullable(),
    enabled: z.boolean(),
    sort_order: z.number().int(),
    updated_at: z.string(),
    dlt_text: z.string(),
    variables: z.array(z.string()),
    preview: smsPreviewSchema,
  })
  .openapi("SmsTemplate");
const adminSmsSchema = z
  .object({
    id: z.string().uuid(),
    user_id: z.string().uuid().nullable(),
    to_phone: z.string(),
    to_phone_masked: z.string().optional(),
    template: z.string(),
    idempotency_key: z.string(),
    data: z.record(z.unknown()),
    body: z.string().nullable(),
    segments: z.number().int().nullable(),
    status: smsStatusSchema,
    mode: z.enum(["test", "live"]),
    provider: z.string().nullable(),
    provider_message_id: z.string().nullable(),
    attempts: z.number().int(),
    last_error: z.string().nullable(),
    send_after: z.string(),
    sent_at: z.string().nullable(),
    delivered_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("AdminSms");

registry.registerPath({
  method: "get",
  path: "/sms/settings",
  tags: ["Admin", "Messaging"],
  summary: "SMS mode, providers (never their keys) and delivery-report addresses (campaigns.view)",
  security,
  responses: { "200": okResponse(smsOverviewSchema), ...errorResponses },
});
registry.registerPath({
  method: "patch",
  path: "/sms/settings",
  tags: ["Admin", "Messaging"],
  summary: "Change SMS mode, provider, DLT sender and entity id, test numbers (channels.manage)",
  security,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            mode: z.enum(["off", "test", "live"]).optional(),
            active_provider: smsProviderIdSchema.nullable().optional(),
            sender_id: z.string().nullable().optional(),
            dlt_entity_id: z.string().nullable().optional(),
            test_numbers: z.array(z.string()).optional(),
            otp_per_hour: z.number().int().min(1).max(30).optional(),
          }),
        },
      },
    },
  },
  responses: { "200": okResponse(smsOverviewSchema), ...errorResponses },
});
registry.registerPath({
  method: "put",
  path: "/sms/hook-secret",
  tags: ["Admin", "Messaging"],
  summary: "Save (or clear with null) the Supabase Send SMS hook secret, kept in Vault (channels.manage)",
  security,
  request: { body: { content: { "application/json": { schema: z.object({ secret: z.string().nullable() }) } } } },
  responses: { "200": okResponse(smsOverviewSchema), ...errorResponses },
});
registry.registerPath({
  method: "put",
  path: "/sms/providers/{provider}",
  tags: ["Admin", "Messaging"],
  summary: "Connect a provider or change its settings; empty secret fields keep the stored key (channels.manage)",
  security,
  request: {
    params: z.object({ provider: smsProviderIdSchema }),
    body: { content: { "application/json": { schema: z.record(z.string()) } } },
  },
  responses: { "200": okResponse(smsOverviewSchema), ...errorResponses },
});
registry.registerPath({
  method: "delete",
  path: "/sms/providers/{provider}",
  tags: ["Admin", "Messaging"],
  summary: "Disconnect a provider and delete its key (channels.manage)",
  security,
  request: { params: z.object({ provider: smsProviderIdSchema }) },
  responses: { "200": okResponse(smsOverviewSchema), ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/sms/templates",
  tags: ["Admin", "Messaging"],
  summary: "Every text: wording, DLT form, DLT template id, preview (campaigns.view)",
  security,
  responses: { "200": okResponse(z.array(smsTemplateSchema)), ...errorResponses },
});
registry.registerPath({
  method: "patch",
  path: "/sms/templates/{key}",
  tags: ["Admin", "Messaging"],
  summary: "Edit a text's wording, DLT template id or switch it off (channels.manage)",
  security,
  request: {
    params: z.object({ key: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            body: z.string().optional(),
            dlt_template_id: z.string().nullable().optional(),
            provider_template_id: z.string().nullable().optional(),
            enabled: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: { "200": okResponse(smsTemplateSchema), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/sms/preview",
  tags: ["Admin", "Messaging"],
  summary: "Preview wording with example values, its length and DLT form (campaigns.view)",
  security,
  request: { body: { content: { "application/json": { schema: z.object({ body: z.string() }) } } } },
  responses: {
    "200": okResponse(smsPreviewSchema.extend({ dlt_text: z.string(), sample_values: z.record(z.union([z.string(), z.number(), z.null()])) })),
    ...errorResponses,
  },
});
registry.registerPath({
  method: "post",
  path: "/sms/test",
  tags: ["Admin", "Messaging"],
  summary: "Send one text with example values to a number (channels.manage)",
  security,
  request: { body: { content: { "application/json": { schema: z.object({ phone: z.string(), template: z.string().optional() }) } } } },
  responses: { "200": okResponse(adminSmsSchema), ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/sms",
  tags: ["Admin", "Messaging"],
  summary: "Texts sent or waiting, newest first (campaigns.view)",
  security,
  request: {
    query: z.object({
      status: smsStatusSchema.optional(),
      template: z.string().optional(),
      search: z.string().optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }),
  },
  responses: { "200": paginatedResponse(adminSmsSchema), ...errorResponses },
});
registry.registerPath({
  method: "get",
  path: "/sms/summary",
  tags: ["Admin", "Messaging"],
  summary: "Texts in each state over the last 7 days, and how many were test-only (campaigns.view)",
  security,
  responses: { "200": okResponse(z.record(z.string(), z.number().int())), ...errorResponses },
});
registry.registerPath({
  method: "post",
  path: "/sms/{id}/resend",
  tags: ["Admin", "Messaging"],
  summary: "Send a failed or skipped text again (campaigns.send)",
  security,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: { "200": okResponse(adminSmsSchema), ...errorResponses },
});

const generator = new OpenApiGeneratorV3(registry.definitions);
const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "ProdBnb Admin API",
    version: "1.0.0",
    description:
      "The /v1/admin/* surface only (Phase 11; Admin Console). Every endpoint requires a Supabase access " +
      "token for a user holding the 'admin' role, and each names the admin team-role permission it needs " +
      "(see GET /me). Base path is mounted at /v1/admin on the ProdBnb backend.",
  },
  servers: [{ url: "/v1/admin" }],
});

const outPath = join(__dirname, "../docs/admin-openapi.json");
writeFileSync(outPath, JSON.stringify(document, null, 2) + "\n");
console.log(`Wrote ${outPath}`);

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
    status: z.enum(["draft", "submitted", "under_review", "approved", "published", "rejected", "suspended", "archived"]),
    moderation_reason: z.string().nullable(),
    suspended_by_host_suspension: z.boolean(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    categories: z.array(catalogRefSchema),
    amenities: z.array(catalogRefSchema),
    use_cases: z.array(catalogRefSchema),
    media: z.array(publicMediaItemSchema),
    host: hostPublicSummarySchema,
    booking_options: z.array(bookingOptionSchema),
  })
  .openapi("LocationDetail");

registry.registerPath({
  method: "get",
  path: "/locations",
  tags: ["Admin", "Locations"],
  summary: "List locations (status/host_id/search filters)",
  security,
  request: { query: adminListLocationsQuerySchema },
  responses: { "200": paginatedResponse(locationDetailSchema), ...errorResponses },
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
    updated_by: z.string().uuid().nullable(),
    updated_at: z.string().datetime(),
  })
  .openapi("PlatformSettings");

registry.registerPath({
  method: "get",
  path: "/settings",
  tags: ["Admin", "Settings"],
  summary: "Platform fee, tax and unpaid-hold window",
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
  .object({ id: z.string().uuid(), name: z.string(), created_at: z.string().datetime(), usage_count: z.number().int() })
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
  summary: "Rename a catalog option (audited)",
  security,
  request: { params: catalogItemParamSchema, body: jsonBody(catalogNameSchema) },
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

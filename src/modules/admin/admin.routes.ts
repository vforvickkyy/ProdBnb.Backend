import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { requireRole } from "../../middleware/requireRole";
import { validate } from "../../middleware/validate";
import { bookingActionSchema, bookingIdParamSchema, listBookingsQuerySchema } from "../bookings/bookings.schema";
import { locationIdParamSchema } from "../locations/locations.schema";
import { createRefundSchema, paymentIdParamSchema } from "../payments/payment.schema";
import {
  getAdminBookingDetail,
  getAdminBookings,
  getAdminDeliveryAttempts,
  getAdminLocationDetail,
  getAdminPaymentDetail,
  getAdminPayments,
  getAdminRefunds,
  getAuditLog,
  getDashboard,
  getUserDetail,
  postAdminCancelBooking,
  postAdminCreateRefund,
  postApproveLocation,
  postRejectLocation,
  postRestoreLocation,
  postRestoreUser,
  postSuspendLocation,
  postSuspendUser,
  getSystemStatusHandler,
} from "./admin.controller";
import {
  addTeamMemberSchema,
  adminConversationsQuerySchema,
  adminListPaymentsQuerySchema,
  adminListRefundsQuerySchema,
  adminUpdateLocationSchema,
  adminUserIdParamSchema,
  analyticsQuerySchema,
  attentionQuerySchema,
  auditLogQuerySchema,
  catalogItemParamSchema,
  catalogKindParamSchema,
  catalogNameSchema,
  catalogUpdateSchema,
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
  teamUserIdParamSchema,
  updateSettingsSchema,
  userRoleParamSchema,
} from "./admin.schema";
import {
  deleteAdminLocationMediaHandler,
  deleteAdminLocationSectionHandler,
  deleteCatalogItemHandler,
  deleteTeamMemberHandler,
  deleteUserRoleHandler,
  getAdminConversationsHandler,
  getAdminLocationGalleryHandler,
  getAnalyticsHandler,
  getCatalogHandler,
  getIntegrationsHandler,
  getMeHandler,
  getMessageAccessLogHandler,
  getPaymentsAttentionHandler,
  getSettingsHandler,
  getTeamHandler,
  patchAdminLocationHandler,
  patchCatalogItemHandler,
  patchSettingsHandler,
  postAdminCompleteBookingHandler,
  postAdminConfirmBookingHandler,
  postAdminRejectBookingHandler,
  postAdminVerifyPaymentHandler,
  postCatalogItemHandler,
  postOpenConversationHandler,
  postTeamMemberHandler,
  postUserRoleHandler,
  putTeamMemberHandler,
} from "./console.controller";
import { adminConsole2Router } from "./console2.routes";
import { requirePermission as can } from "./permissions";

export const adminRouter = Router();

// Applied ONCE, here, for every route this router will ever define --
// centralizes the security gate for the whole /v1/admin/* surface, rather
// than repeating `requireAuth, requireRole('admin')` per route the way the
// two pre-Phase-11 admin routes (GET /v1/admin/users, GET
// /v1/admin/locations) did. A booker/host hitting anything under this
// router gets 403 before any handler runs, with no per-route chance to
// forget the gate.
//
// Admin Console: every route additionally names the team-role permission it needs (`can(...)`,
// src/modules/admin/permissions.ts). The router-level gate answers "is this an administrator";
// the per-route one answers "may THIS administrator do THIS".
adminRouter.use(requireAuth, requireRole("admin"));

adminRouter.get("/me", getMeHandler);
adminRouter.get("/dashboard", can("dashboard.view"), getDashboard);
adminRouter.get("/system/status", can("system.view"), getSystemStatusHandler);
adminRouter.get("/system/integrations", can("system.view"), validate({ query: integrationsQuerySchema }), getIntegrationsHandler);
adminRouter.get("/analytics", can("analytics.view"), validate({ query: analyticsQuerySchema }), getAnalyticsHandler);

// -- Team & settings ----------------------------------------------------------------------------

adminRouter.get("/team", can("audit.view"), getTeamHandler);
adminRouter.post("/team", can("team.manage"), validate({ body: addTeamMemberSchema }), postTeamMemberHandler);
adminRouter.put(
  "/team/:userId",
  can("team.manage"),
  validate({ params: teamUserIdParamSchema, body: setTeamRoleSchema }),
  putTeamMemberHandler
);
adminRouter.delete("/team/:userId", can("team.manage"), validate({ params: teamUserIdParamSchema }), deleteTeamMemberHandler);

adminRouter.get("/settings", can("settings.view"), getSettingsHandler);
adminRouter.patch("/settings", can("settings.manage"), validate({ body: updateSettingsSchema }), patchSettingsHandler);

// -- Users --------------------------------------------------------------
// GET /admin/users already exists (src/modules/users/users.routes.ts,
// extended in place this phase with search/role/status filters) -- not
// redefined here to avoid two competing route registrations for the same
// path. Everything below is genuinely new.

adminRouter.get("/users/:id", can("users.view"), validate({ params: adminUserIdParamSchema }), getUserDetail);
adminRouter.post(
  "/users/:id/suspend",
  can("users.manage"),
  validate({ params: adminUserIdParamSchema, body: suspendUserSchema }),
  postSuspendUser
);
adminRouter.post(
  "/users/:id/restore",
  can("users.manage"),
  validate({ params: adminUserIdParamSchema, body: noBodySchema }),
  postRestoreUser
);
adminRouter.post("/users/:id/roles/:role", can("users.manage"), validate({ params: userRoleParamSchema }), postUserRoleHandler);
adminRouter.delete("/users/:id/roles/:role", can("users.manage"), validate({ params: userRoleParamSchema }), deleteUserRoleHandler);

// -- Locations ------------------------------------------------------------
// GET /admin/locations already exists (src/modules/locations/locations.routes.ts,
// extended in place this phase with host_id/search filters) -- same
// no-duplicate-route reasoning as /admin/users above.

adminRouter.get("/locations/:id", can("locations.view"), validate({ params: locationIdParamSchema }), getAdminLocationDetail);
adminRouter.patch(
  "/locations/:id",
  can("locations.moderate"),
  validate({ params: locationIdParamSchema, body: adminUpdateLocationSchema }),
  patchAdminLocationHandler
);
adminRouter.get("/locations/:id/gallery", can("locations.view"), validate({ params: locationIdParamSchema }), getAdminLocationGalleryHandler);
// POST, not DELETE: the optional moderation reason is a request body, which OpenAPI 3.0 does not
// define for DELETE (the Admin Panel's generated client could not send it).
adminRouter.post(
  "/locations/:id/media/:mediaId/remove",
  can("locations.moderate"),
  validate({ params: locationMediaParamSchema, body: optionalReasonSchema }),
  deleteAdminLocationMediaHandler
);
adminRouter.post(
  "/locations/:id/sections/:sectionId/remove",
  can("locations.moderate"),
  validate({ params: locationSectionParamSchema, body: optionalReasonSchema }),
  deleteAdminLocationSectionHandler
);
adminRouter.post(
  "/locations/:id/approve",
  can("locations.moderate"),
  validate({ params: locationIdParamSchema, body: noBodySchema }),
  postApproveLocation
);
adminRouter.post(
  "/locations/:id/reject",
  can("locations.moderate"),
  validate({ params: locationIdParamSchema, body: rejectLocationSchema }),
  postRejectLocation
);
adminRouter.post(
  "/locations/:id/suspend",
  can("locations.moderate"),
  validate({ params: locationIdParamSchema, body: suspendLocationSchema }),
  postSuspendLocation
);
adminRouter.post(
  "/locations/:id/restore",
  can("locations.moderate"),
  validate({ params: locationIdParamSchema, body: noBodySchema }),
  postRestoreLocation
);

// -- Catalog -------------------------------------------------------------------------------------

adminRouter.get("/catalog/:kind", can("locations.view"), validate({ params: catalogKindParamSchema }), getCatalogHandler);
adminRouter.post(
  "/catalog/:kind",
  can("catalog.manage"),
  validate({ params: catalogKindParamSchema, body: catalogNameSchema }),
  postCatalogItemHandler
);
adminRouter.patch(
  "/catalog/:kind/:itemId",
  can("catalog.manage"),
  validate({ params: catalogItemParamSchema, body: catalogUpdateSchema }),
  patchCatalogItemHandler
);
adminRouter.delete("/catalog/:kind/:itemId", can("catalog.manage"), validate({ params: catalogItemParamSchema }), deleteCatalogItemHandler);

// -- Bookings ---------------------------------------------------------------
// Thin wrappers around the existing, unmodified booking engine
// (bookings.service.ts) -- no new cancellation logic, no bypass of the
// EXCLUDE constraint or the booking lifecycle's existing status guards.

adminRouter.get("/bookings", can("bookings.view"), validate({ query: listBookingsQuerySchema }), getAdminBookings);
adminRouter.get("/bookings/:id", can("bookings.view"), validate({ params: bookingIdParamSchema }), getAdminBookingDetail);
adminRouter.post(
  "/bookings/:id/cancel",
  can("bookings.manage"),
  validate({ params: bookingIdParamSchema, body: bookingActionSchema }),
  postAdminCancelBooking
);
adminRouter.post(
  "/bookings/:id/confirm",
  can("bookings.manage"),
  validate({ params: bookingIdParamSchema, body: noBodySchema }),
  postAdminConfirmBookingHandler
);
adminRouter.post(
  "/bookings/:id/reject",
  can("bookings.manage"),
  validate({ params: bookingIdParamSchema, body: bookingActionSchema }),
  postAdminRejectBookingHandler
);
adminRouter.post(
  "/bookings/:id/complete",
  can("bookings.manage"),
  validate({ params: bookingIdParamSchema, body: noBodySchema }),
  postAdminCompleteBookingHandler
);

// -- Payments / refunds -----------------------------------------------------
// Thin wrappers around the existing PaymentService/PaymentProvider
// architecture (Phase 7) -- no Cashfree-specific code here.

adminRouter.get("/payments", can("payments.view"), validate({ query: adminListPaymentsQuerySchema }), getAdminPayments);
// Registered before /payments/:id so "attention" is never parsed as a payment id.
adminRouter.get("/payments/attention", can("payments.view"), validate({ query: attentionQuerySchema }), getPaymentsAttentionHandler);
adminRouter.get("/payments/:id", can("payments.view"), validate({ params: paymentIdParamSchema }), getAdminPaymentDetail);
adminRouter.post(
  "/payments/:id/verify",
  can("payments.verify"),
  validate({ params: paymentIdParamSchema, body: noBodySchema }),
  postAdminVerifyPaymentHandler
);
adminRouter.get("/refunds", can("payments.view"), validate({ query: adminListRefundsQuerySchema }), getAdminRefunds);
adminRouter.post(
  "/payments/:id/refunds",
  can("payments.refund"),
  validate({ params: paymentIdParamSchema, body: createRefundSchema }),
  postAdminCreateRefund
);

// -- Dispute message access ------------------------------------------------------------------------

adminRouter.get("/conversations", can("messages.access"), validate({ query: adminConversationsQuerySchema }), getAdminConversationsHandler);
adminRouter.post(
  "/conversations/:id/access",
  can("messages.access"),
  validate({ params: conversationIdParamSchema, body: openConversationSchema }),
  postOpenConversationHandler
);
adminRouter.get("/message-access-log", can("audit.view"), validate({ query: messageAccessLogQuerySchema }), getMessageAccessLogHandler);

// -- Notifications (delivery diagnostics only, never notification content) --

adminRouter.get(
  "/notifications/delivery-attempts",
  can("notifications.diagnostics"),
  validate({ query: deliveryAttemptsQuerySchema }),
  getAdminDeliveryAttempts
);

// -- Audit log ----------------------------------------------------------

adminRouter.get("/audit-log", can("audit.view"), validate({ query: auditLogQuerySchema }), getAuditLog);

// -- Admin Console 2 (listings for hosts, catalog covers, collections, messaging, platforms) --------
adminRouter.use(adminConsole2Router);

import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import {
  deleteAllNotificationsHandler,
  deleteNotificationHandler,
  getNotificationDetail,
  getNotificationPreferences,
  getNotifications,
  patchNotificationPreferences,
  postMarkAllRead,
  postMarkRead,
} from "./notification.controller";
import {
  clearNotificationsQuerySchema,
  listNotificationsQuerySchema,
  notificationIdParamSchema,
  updatePreferencesSchema,
} from "./notification.schema";

export const notificationsRouter = Router();

notificationsRouter.get("/notifications", requireAuth, validate({ query: listNotificationsQuerySchema }), getNotifications);

notificationsRouter.get(
  "/notifications/:id",
  requireAuth,
  validate({ params: notificationIdParamSchema }),
  getNotificationDetail
);

notificationsRouter.post(
  "/notifications/:id/read",
  requireAuth,
  validate({ params: notificationIdParamSchema }),
  postMarkRead
);

notificationsRouter.post("/notifications/read-all", requireAuth, postMarkAllRead);

// Soft delete (Phase 29.12). Registered AFTER /notifications/read-all for
// consistency with the rest of the file; there is no path conflict either way
// since that route is a POST.
notificationsRouter.delete(
  "/notifications/:id",
  requireAuth,
  validate({ params: notificationIdParamSchema }),
  deleteNotificationHandler
);

// "Clear all" (soft delete of the whole inbox).
notificationsRouter.delete(
  "/notifications",
  requireAuth,
  validate({ query: clearNotificationsQuerySchema }),
  deleteAllNotificationsHandler
);

notificationsRouter.get("/notification-preferences", requireAuth, getNotificationPreferences);

notificationsRouter.patch(
  "/notification-preferences",
  requireAuth,
  validate({ body: updatePreferencesSchema }),
  patchNotificationPreferences
);

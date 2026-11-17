import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { requireRole } from "../../middleware/requireRole";
import { requirePermission } from "../admin/permissions";
import { validate } from "../../middleware/validate";
import { preferencesSchema } from "./preferences.service";
import { getMe, getMyPreferences, listUsers, patchMe, putMyPreferences } from "./users.controller";
import { listUsersQuerySchema, updateProfileSchema } from "./users.schema";

export const usersRouter = Router();

usersRouter.get("/me", requireAuth, getMe);
usersRouter.patch("/me", requireAuth, validate({ body: updateProfileSchema }), patchMe);
usersRouter.get("/me/preferences", requireAuth, getMyPreferences);
usersRouter.put("/me/preferences", requireAuth, validate({ body: preferencesSchema }), putMyPreferences);

// Proves the admin-authorization foundation end-to-end: gated by requireRole,
// and backed by RLS (profiles_select_own_or_admin) rather than a service-role
// bypass.
usersRouter.get(
  "/admin/users",
  requireAuth,
  requireRole("admin"),
  requirePermission("users.view"),
  validate({ query: listUsersQuerySchema }),
  listUsers
);

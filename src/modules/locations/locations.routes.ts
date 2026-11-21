import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { optionalAuth } from "../../middleware/optionalAuth";
import { requireRole } from "../../middleware/requireRole";
import { requirePermission } from "../admin/permissions";
import { validate } from "../../middleware/validate";
import { getCityPages, getSearchResults } from "../search/search.controller";
import { searchLocationsQuerySchema } from "../search/search.schema";
import {
  deleteLocationHandler,
  getAdminLocations,
  getLocationDetail,
  getMyLocations,
  patchLocation,
  postLocation,
} from "./locations.controller";
import {
  adminListLocationsQuerySchema,
  createLocationSchema,
  listLocationsQuerySchema,
  locationIdParamSchema,
  updateLocationSchema,
} from "./locations.schema";

export const locationsRouter = Router();

// Public marketplace feed / discovery (Phase 4: text search, geo, filters,
// sorting — see src/modules/search/). Always published-only, always an
// anonymous client — a host's own drafts never leak into this just because
// they happen to be signed in while browsing.
locationsRouter.get("/locations", validate({ query: searchLocationsQuerySchema }), getSearchResults);

// The cities (and the shoot types in each) that have published listings: what the website's city pages
// are built from.
locationsRouter.get("/cities", getCityPages);

// A host's own listings, any status.
locationsRouter.get("/me/locations", requireAuth, validate({ query: listLocationsQuerySchema }), getMyLocations);

// Admin review queue: every location, optional status filter.
locationsRouter.get(
  "/admin/locations",
  requireAuth,
  requireRole("admin"),
  requirePermission("locations.view"),
  validate({ query: adminListLocationsQuerySchema }),
  getAdminLocations
);

// Detail: published is public; draft/etc. is owner-or-admin only (RLS-enforced).
locationsRouter.get("/locations/:id", optionalAuth, validate({ params: locationIdParamSchema }), getLocationDetail);

locationsRouter.post(
  "/locations",
  requireAuth,
  requireRole("host"),
  validate({ body: createLocationSchema }),
  postLocation
);

locationsRouter.patch(
  "/locations/:id",
  requireAuth,
  validate({ params: locationIdParamSchema, body: updateLocationSchema }),
  patchLocation
);

locationsRouter.delete(
  "/locations/:id",
  requireAuth,
  validate({ params: locationIdParamSchema }),
  deleteLocationHandler
);

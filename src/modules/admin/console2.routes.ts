import { Request, Response, Router } from "express";
import { env } from "../../config/env";
import { ValidationError } from "../../errors/AppError";
import { allowBrowserUploads } from "../../lib/r2";
import { adminClient } from "../../lib/supabase";
import { ok } from "../../utils/respond";
import { writeAuditLog } from "./audit.service";
import { validate } from "../../middleware/validate";
import {
  adminCreateLocationSchema,
  catalogItemParamSchema,
  catalogListingParamSchema,
  catalogListingsQuerySchema,
  collectionCreateSchema,
  collectionIdParamSchema,
  collectionListingParamSchema,
  collectionUpdateSchema,
  coverCompleteSchema,
  coverUploadRequestSchema,
  hostSearchQuerySchema,
  locationIdsSchema,
  orderedLocationIdsSchema,
} from "./admin.schema";
import {
  deleteCatalogCoverHandler,
  deleteCatalogListingHandler,
  deleteCollectionCoverHandler,
  deleteCollectionHandler,
  deleteCollectionListingHandler,
  getCatalogListingsHandler,
  getCollectionHandler,
  getCollectionsHandler,
  getHostCandidatesHandler,
  postAdminCreateLocationHandler,
  postCatalogCoverUploadHandler,
  postCatalogListingsHandler,
  postCollectionCoverUploadHandler,
  postCollectionHandler,
  postCollectionListingsHandler,
  patchCollectionHandler,
  putCatalogCoverHandler,
  putCollectionCoverHandler,
  putCollectionOrderHandler,
} from "./console2.controller";
import { adminOutreachRouter } from "../outreach/outreach.routes";
import { adminPlatformsRouter } from "../platform/releases.routes";
import { adminSiteRouter } from "../site/site.routes";
import { browserUploadOrigins } from "../site/integrations.service";
import { adminContentRouter } from "../content/content.routes";
import { adminAccountRouter } from "../account/account.routes";
import { adminPayoutsRouter } from "../payouts/payouts.routes";
import { requirePermission as can } from "./permissions";

/**
 * Admin Console 2 routes. Mounted INSIDE adminRouter (after its requireAuth + requireRole("admin")
 * gate), so every route here is already admin-only; each additionally names its permission.
 *
 * Editing an existing listing in full -- photos, cover, order, pricing, timings, sections -- needs no
 * new route: the shared listing endpoints (/v1/locations/:id/media, /pricing, /availability/*,
 * /sections) already accept an administrator holding `locations.moderate`, and now audit it.
 */
export const adminConsole2Router = Router();

// -- Listings for a host -----------------------------------------------------------------------------

adminConsole2Router.post("/locations", can("locations.create"), validate({ body: adminCreateLocationSchema }), postAdminCreateLocationHandler);
adminConsole2Router.get("/hosts/search", can("users.view"), validate({ query: hostSearchQuerySchema }), getHostCandidatesHandler);

// -- Catalog covers + listings ---------------------------------------------------------------------

adminConsole2Router.post(
  "/catalog/:kind/:itemId/cover/upload",
  can("catalog.manage"),
  validate({ params: catalogItemParamSchema, body: coverUploadRequestSchema }),
  postCatalogCoverUploadHandler
);
adminConsole2Router.put(
  "/catalog/:kind/:itemId/cover",
  can("catalog.manage"),
  validate({ params: catalogItemParamSchema, body: coverCompleteSchema }),
  putCatalogCoverHandler
);
adminConsole2Router.delete("/catalog/:kind/:itemId/cover", can("catalog.manage"), validate({ params: catalogItemParamSchema }), deleteCatalogCoverHandler);
adminConsole2Router.get(
  "/catalog/:kind/:itemId/listings",
  can("locations.view"),
  validate({ params: catalogItemParamSchema, query: catalogListingsQuerySchema }),
  getCatalogListingsHandler
);
adminConsole2Router.post(
  "/catalog/:kind/:itemId/listings",
  can("catalog.manage"),
  validate({ params: catalogItemParamSchema, body: locationIdsSchema }),
  postCatalogListingsHandler
);
adminConsole2Router.delete(
  "/catalog/:kind/:itemId/listings/:locationId",
  can("catalog.manage"),
  validate({ params: catalogListingParamSchema }),
  deleteCatalogListingHandler
);

// -- Collections -----------------------------------------------------------------------------------

adminConsole2Router.get("/collections", can("locations.view"), getCollectionsHandler);
adminConsole2Router.post("/collections", can("catalog.manage"), validate({ body: collectionCreateSchema }), postCollectionHandler);
adminConsole2Router.get("/collections/:collectionId", can("locations.view"), validate({ params: collectionIdParamSchema }), getCollectionHandler);
adminConsole2Router.patch(
  "/collections/:collectionId",
  can("catalog.manage"),
  validate({ params: collectionIdParamSchema, body: collectionUpdateSchema }),
  patchCollectionHandler
);
adminConsole2Router.delete("/collections/:collectionId", can("catalog.manage"), validate({ params: collectionIdParamSchema }), deleteCollectionHandler);
adminConsole2Router.post(
  "/collections/:collectionId/cover/upload",
  can("catalog.manage"),
  validate({ params: collectionIdParamSchema, body: coverUploadRequestSchema }),
  postCollectionCoverUploadHandler
);
adminConsole2Router.put(
  "/collections/:collectionId/cover",
  can("catalog.manage"),
  validate({ params: collectionIdParamSchema, body: coverCompleteSchema }),
  putCollectionCoverHandler
);
adminConsole2Router.delete(
  "/collections/:collectionId/cover",
  can("catalog.manage"),
  validate({ params: collectionIdParamSchema }),
  deleteCollectionCoverHandler
);
adminConsole2Router.post(
  "/collections/:collectionId/listings",
  can("catalog.manage"),
  validate({ params: collectionIdParamSchema, body: locationIdsSchema }),
  postCollectionListingsHandler
);
adminConsole2Router.put(
  "/collections/:collectionId/listings/order",
  can("catalog.manage"),
  validate({ params: collectionIdParamSchema, body: orderedLocationIdsSchema }),
  putCollectionOrderHandler
);
adminConsole2Router.delete(
  "/collections/:collectionId/listings/:locationId",
  can("catalog.manage"),
  validate({ params: collectionListingParamSchema }),
  deleteCollectionListingHandler
);

// -- Messaging: channels, background jobs, announcements and direct notifications -----------------
adminConsole2Router.use(adminOutreachRouter);

// -- Platforms: release control, feature flags, incidents, releases ------------------------------
adminConsole2Router.use(adminPlatformsRouter);

// Website (Console 3): integrations (Google Maps, Vercel) and domains.
adminConsole2Router.use(adminSiteRouter);
adminConsole2Router.use(adminContentRouter);
adminConsole2Router.use(adminAccountRouter);
adminConsole2Router.use(adminPayoutsRouter);

// -- R2 browser uploads -----------------------------------------------------------------------------
// One click on the Integrations page adds a CORS rule letting the backend's CORS_ORIGINS PUT to the
// bucket. Existing rules are kept. Requires an R2 API token with bucket-admin scope; with a plain
// object read/write token Cloudflare refuses, and the error says so.
adminConsole2Router.post("/system/r2-cors", can("settings.manage"), async (req: Request, res: Response) => {
  // The admin console's origins and the website's primary domain (hosts upload listing photos there).
  const origins = await browserUploadOrigins();
  if (origins.length === 0) {
    throw new ValidationError("CORS_ORIGINS is empty on the backend -- set it to the Admin Console's URL first.");
  }
  let rules;
  try {
    rules = await allowBrowserUploads(origins);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cloudflare refused the change.";
    throw new ValidationError(
      `Could not update the bucket's CORS rules (${message.slice(0, 200)}). The R2 API token may lack admin scope -- add the rule in the Cloudflare dashboard instead.`
    );
  }
  const { data } = await adminClient.from("platform_settings").select("id").eq("singleton", true).single();
  if (data) {
    await writeAuditLog(req.user!.id, "ADMIN_UPDATED_SETTINGS", "settings", (data as { id: string }).id, null, {
      change: "r2_cors_allow_browser_uploads",
      origins,
    });
  }
  ok(res, { rules });
});

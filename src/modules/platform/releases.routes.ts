import { Request, Response, Router } from "express";
import { optionalAuth } from "../../middleware/optionalAuth";
import { validate } from "../../middleware/validate";
import { created, ok } from "../../utils/respond";
import { requirePermission as can } from "../admin/permissions";
import {
  AppConfigQuery,
  appConfigQuerySchema,
  CreateFeatureFlagInput,
  createFeatureFlagSchema,
  CreateIncidentInput,
  createIncidentSchema,
  CreateReleaseInput,
  createReleaseSchema,
  FlagIdParam,
  flagIdParamSchema,
  IncidentIdParam,
  incidentIdParamSchema,
  PlatformParam,
  platformParamSchema,
  ReleaseIdParam,
  releaseIdParamSchema,
  UpdateFeatureFlagInput,
  updateFeatureFlagSchema,
  UpdateIncidentInput,
  updateIncidentSchema,
  UpdatePlatformInput,
  updatePlatformSchema,
  UpdateReleaseInput,
  updateReleaseSchema,
} from "./releases.schema";
import {
  createFeatureFlag,
  createIncident,
  createRelease,
  deleteFeatureFlag,
  deleteRelease,
  getAppConfig,
  getPlatformsOverview,
  updateFeatureFlag,
  updateIncident,
  updatePlatform,
  updateRelease,
} from "./releases.service";

/** Admin Console 2 -- platform release control. Mounted inside adminRouter (already admin-gated). */
export const adminPlatformsRouter = Router();

adminPlatformsRouter.get("/platforms", can("platforms.view"), async (_req: Request, res: Response) => {
  ok(res, await getPlatformsOverview());
});
adminPlatformsRouter.patch(
  "/platforms/:platform",
  can("platforms.manage"),
  validate({ params: platformParamSchema, body: updatePlatformSchema }),
  async (req: Request, res: Response) => {
    const { platform } = req.valid!.params as PlatformParam;
    ok(res, await updatePlatform(req.user!.id, platform, req.valid!.body as UpdatePlatformInput));
  }
);

adminPlatformsRouter.post("/feature-flags", can("platforms.manage"), validate({ body: createFeatureFlagSchema }), async (req: Request, res: Response) => {
  created(res, await createFeatureFlag(req.user!.id, req.valid!.body as CreateFeatureFlagInput));
});
adminPlatformsRouter.patch(
  "/feature-flags/:flagId",
  can("platforms.manage"),
  validate({ params: flagIdParamSchema, body: updateFeatureFlagSchema }),
  async (req: Request, res: Response) => {
    const { flagId } = req.valid!.params as FlagIdParam;
    ok(res, await updateFeatureFlag(req.user!.id, flagId, req.valid!.body as UpdateFeatureFlagInput));
  }
);
adminPlatformsRouter.delete("/feature-flags/:flagId", can("platforms.manage"), validate({ params: flagIdParamSchema }), async (req: Request, res: Response) => {
  const { flagId } = req.valid!.params as FlagIdParam;
  await deleteFeatureFlag(req.user!.id, flagId);
  ok(res, { deleted: true });
});

adminPlatformsRouter.post("/incidents", can("incidents.manage"), validate({ body: createIncidentSchema }), async (req: Request, res: Response) => {
  created(res, await createIncident(req.user!.id, req.valid!.body as CreateIncidentInput));
});
adminPlatformsRouter.patch(
  "/incidents/:incidentId",
  can("incidents.manage"),
  validate({ params: incidentIdParamSchema, body: updateIncidentSchema }),
  async (req: Request, res: Response) => {
    const { incidentId } = req.valid!.params as IncidentIdParam;
    ok(res, await updateIncident(req.user!.id, incidentId, req.valid!.body as UpdateIncidentInput));
  }
);

adminPlatformsRouter.post("/releases", can("platforms.manage"), validate({ body: createReleaseSchema }), async (req: Request, res: Response) => {
  created(res, await createRelease(req.user!.id, req.valid!.body as CreateReleaseInput));
});
adminPlatformsRouter.patch(
  "/releases/:releaseId",
  can("platforms.manage"),
  validate({ params: releaseIdParamSchema, body: updateReleaseSchema }),
  async (req: Request, res: Response) => {
    const { releaseId } = req.valid!.params as ReleaseIdParam;
    ok(res, await updateRelease(req.user!.id, releaseId, req.valid!.body as UpdateReleaseInput));
  }
);
adminPlatformsRouter.delete("/releases/:releaseId", can("platforms.manage"), validate({ params: releaseIdParamSchema }), async (req: Request, res: Response) => {
  const { releaseId } = req.valid!.params as ReleaseIdParam;
  await deleteRelease(req.user!.id, releaseId);
  ok(res, { deleted: true });
});

/**
 * Public. One small response an app reads at launch (and on foreground): status, maintenance,
 * update prompts, feature flags, open public incidents. Identical for every caller of a given
 * platform+version, so it is publicly cacheable for 30s; optionalAuth only lets a signed-in app's
 * version be counted on the Platforms page.
 */
export const publicPlatformsRouter = Router();

publicPlatformsRouter.get("/app-config", optionalAuth, validate({ query: appConfigQuerySchema }), async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "public, max-age=30");
  ok(res, await getAppConfig(req.valid!.query as AppConfigQuery));
});

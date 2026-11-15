import { Request, Response, Router } from "express";
import { validate } from "../../middleware/validate";
import { created, ok } from "../../utils/respond";
import { requirePermission as can } from "../admin/permissions";
import { addSiteDomain, listSiteDomains, removeSiteDomain, setPrimaryDomain, updateSiteDomain, verifySiteDomain } from "./domains.service";
import {
  getPublicSiteConfig,
  listSiteIntegrations,
  removeSiteIntegration,
  saveGoogleMaps,
  saveVercel,
  testSiteIntegration,
} from "./integrations.service";
import {
  AddDomainInput,
  addDomainSchema,
  DomainParam,
  domainParamSchema,
  PrimaryDomainInput,
  primaryDomainSchema,
  SaveGoogleMapsInput,
  saveGoogleMapsSchema,
  SaveVercelInput,
  saveVercelSchema,
  SiteProviderParam,
  siteProviderParamSchema,
  UpdateDomainInput,
  updateDomainSchema,
} from "./site.schema";

/** Website (Console 3) -- admin routes. Mounted inside adminRouter (already admin-gated). */
export const adminSiteRouter = Router();

adminSiteRouter.get("/site/integrations", can("site.view"), async (_req: Request, res: Response) => {
  ok(res, await listSiteIntegrations());
});
adminSiteRouter.put(
  "/site/integrations/google_maps",
  can("site.manage"),
  validate({ body: saveGoogleMapsSchema }),
  async (req: Request, res: Response) => {
    ok(res, await saveGoogleMaps(req.user!.id, req.valid!.body as SaveGoogleMapsInput));
  }
);
adminSiteRouter.put("/site/integrations/vercel", can("site.manage"), validate({ body: saveVercelSchema }), async (req: Request, res: Response) => {
  ok(res, await saveVercel(req.user!.id, req.valid!.body as SaveVercelInput));
});
adminSiteRouter.post(
  "/site/integrations/:provider/test",
  can("site.manage"),
  validate({ params: siteProviderParamSchema }),
  async (req: Request, res: Response) => {
    ok(res, await testSiteIntegration((req.valid!.params as SiteProviderParam).provider));
  }
);
adminSiteRouter.delete(
  "/site/integrations/:provider",
  can("site.manage"),
  validate({ params: siteProviderParamSchema }),
  async (req: Request, res: Response) => {
    ok(res, { removed: await removeSiteIntegration(req.user!.id, (req.valid!.params as SiteProviderParam).provider) });
  }
);

adminSiteRouter.get("/site/domains", can("site.view"), async (_req: Request, res: Response) => {
  ok(res, await listSiteDomains());
});
adminSiteRouter.post("/site/domains", can("site.manage"), validate({ body: addDomainSchema }), async (req: Request, res: Response) => {
  created(res, await addSiteDomain(req.user!.id, req.valid!.body as AddDomainInput));
});
adminSiteRouter.patch(
  "/site/domains/:domain",
  can("site.manage"),
  validate({ params: domainParamSchema, body: updateDomainSchema }),
  async (req: Request, res: Response) => {
    const { domain } = req.valid!.params as DomainParam;
    ok(res, await updateSiteDomain(req.user!.id, domain, (req.valid!.body as UpdateDomainInput).redirect_to));
  }
);
adminSiteRouter.post("/site/domains/:domain/verify", can("site.manage"), validate({ params: domainParamSchema }), async (req: Request, res: Response) => {
  ok(res, await verifySiteDomain((req.valid!.params as DomainParam).domain));
});
adminSiteRouter.delete("/site/domains/:domain", can("site.manage"), validate({ params: domainParamSchema }), async (req: Request, res: Response) => {
  await removeSiteDomain(req.user!.id, (req.valid!.params as DomainParam).domain);
  ok(res, { removed: true });
});
adminSiteRouter.put("/site/primary-domain", can("site.manage"), validate({ body: primaryDomainSchema }), async (req: Request, res: Response) => {
  ok(res, await setPrimaryDomain(req.user!.id, (req.valid!.body as PrimaryDomainInput).domain));
});

/** Website (Console 3) -- public: what the website needs at runtime. No secrets. */
export const publicSiteRouter = Router();

publicSiteRouter.get("/site-config", async (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
  ok(res, await getPublicSiteConfig());
});

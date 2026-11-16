import { Request, Response, Router } from "express";
import { validate } from "../../middleware/validate";
import { created, ok } from "../../utils/respond";
import { requirePermission as can } from "../admin/permissions";
import {
  CreatePageInput,
  createPageSchema,
  ListSeoQuery,
  listSeoQuerySchema,
  PageIdParam,
  pageIdParamSchema,
  PublicPageParam,
  publicPageParamSchema,
  SaveSeoInput,
  saveSeoSchema,
  SeoKeyParam,
  seoKeyParamSchema,
  SiteContactInput,
  siteContactSchema,
  UpdatePageInput,
  updatePageSchema,
} from "./content.schema";
import { createPage, deletePage, getPage, getPublishedPage, listPages, listPublishedPages, updatePage } from "./pages.service";
import { getSiteSettings, setSupportEmail } from "../site/integrations.service";
import { getPublicSeo, getSeoOverride, listNoindex, listSeoOverrides, saveSeoOverride } from "./seo.service";

/** Website pages + SEO -- admin routes. Mounted inside the admin router (already admin-gated). */
export const adminContentRouter = Router();

adminContentRouter.get("/site/pages", can("site.view"), async (_req: Request, res: Response) => {
  ok(res, await listPages());
});
adminContentRouter.post("/site/pages", can("content.manage"), validate({ body: createPageSchema }), async (req: Request, res: Response) => {
  created(res, await createPage(req.user!.id, req.valid!.body as CreatePageInput));
});
adminContentRouter.get("/site/pages/:id", can("site.view"), validate({ params: pageIdParamSchema }), async (req: Request, res: Response) => {
  ok(res, await getPage((req.valid!.params as PageIdParam).id));
});
adminContentRouter.patch(
  "/site/pages/:id",
  can("content.manage"),
  validate({ params: pageIdParamSchema, body: updatePageSchema }),
  async (req: Request, res: Response) => {
    ok(res, await updatePage(req.user!.id, (req.valid!.params as PageIdParam).id, req.valid!.body as UpdatePageInput));
  }
);
adminContentRouter.delete("/site/pages/:id", can("content.manage"), validate({ params: pageIdParamSchema }), async (req: Request, res: Response) => {
  await deletePage(req.user!.id, (req.valid!.params as PageIdParam).id);
  ok(res, { removed: true });
});

adminContentRouter.get("/site/seo", can("site.view"), validate({ query: listSeoQuerySchema }), async (req: Request, res: Response) => {
  ok(res, await listSeoOverrides((req.valid!.query as ListSeoQuery).type));
});
adminContentRouter.get("/site/seo/:type/:key", can("site.view"), validate({ params: seoKeyParamSchema }), async (req: Request, res: Response) => {
  const { type, key } = req.valid!.params as SeoKeyParam;
  ok(res, await getSeoOverride(type, key));
});
adminContentRouter.put(
  "/site/seo/:type/:key",
  can("content.manage"),
  validate({ params: seoKeyParamSchema, body: saveSeoSchema }),
  async (req: Request, res: Response) => {
    const { type, key } = req.valid!.params as SeoKeyParam;
    ok(res, await saveSeoOverride(req.user!.id, type, key, req.valid!.body as SaveSeoInput));
  }
);

adminContentRouter.get("/site/contact", can("site.view"), async (_req: Request, res: Response) => {
  ok(res, await getSiteSettings());
});
adminContentRouter.put("/site/contact", can("content.manage"), validate({ body: siteContactSchema }), async (req: Request, res: Response) => {
  const body = req.valid!.body as SiteContactInput;
  ok(res, await setSupportEmail(req.user!.id, body.support_email, body.reason));
});

/** Website pages + SEO -- public. */
export const publicContentRouter = Router();

publicContentRouter.get("/site-pages", async (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
  ok(res, await listPublishedPages());
});
publicContentRouter.get("/site-pages/:slug", validate({ params: publicPageParamSchema }), async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
  ok(res, await getPublishedPage((req.valid!.params as PublicPageParam).slug));
});
publicContentRouter.get("/seo/noindex", async (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
  ok(res, await listNoindex());
});
publicContentRouter.get("/seo/:type/:key", validate({ params: seoKeyParamSchema }), async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
  const { type, key } = req.valid!.params as SeoKeyParam;
  ok(res, await getPublicSeo(type, key));
});

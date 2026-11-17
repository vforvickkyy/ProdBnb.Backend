import { Request, Response, Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { requireRole } from "../../middleware/requireRole";
import { validate } from "../../middleware/validate";
import { created, ok } from "../../utils/respond";
import { writeAuditLog } from "../admin/audit.service";
import { requirePermission as can } from "../admin/permissions";
import { locationIdParamSchema, type LocationIdParam } from "../locations/locations.schema";
import {
  adminCreateCouponSchema,
  couponIdParamSchema,
  createCouponSchema,
  listCouponsQuerySchema,
  updateCouponSchema,
  type AdminCreateCouponInput,
  type CreateCouponInput,
  type ListCouponsQuery,
  type UpdateCouponInput,
} from "./coupons.schema";
import { allOffers, createCoupon, deleteCoupon, getCoupon, listCoupons, offersForLocation, updateCoupon } from "./coupons.service";

type IdParam = { id: string };

// -- Public offers ---------------------------------------------------------------------------------

export const publicOffersRouter = Router();
publicOffersRouter.get("/offers", async (_req: Request, res: Response) => {
  ok(res, await allOffers());
});
publicOffersRouter.get("/locations/:id/offers", validate({ params: locationIdParamSchema }), async (req: Request, res: Response) => {
  ok(res, await offersForLocation((req.valid!.params as LocationIdParam).id));
});

// -- A host's own coupons ------------------------------------------------------------------------

export const hostCouponsRouter = Router();
hostCouponsRouter.get("/me/coupons", requireAuth, requireRole("host"), validate({ query: listCouponsQuerySchema }), async (req: Request, res: Response) => {
  const query = req.valid!.query as ListCouponsQuery;
  const { data, total } = await listCoupons(query, req.user!.id);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
});
hostCouponsRouter.post("/me/coupons", requireAuth, requireRole("host"), validate({ body: createCouponSchema }), async (req: Request, res: Response) => {
  created(res, await createCoupon(req.valid!.body as CreateCouponInput, { type: "host", hostId: req.user!.id, createdBy: req.user!.id }));
});
hostCouponsRouter.get("/me/coupons/:id", requireAuth, requireRole("host"), validate({ params: couponIdParamSchema }), async (req: Request, res: Response) => {
  ok(res, await getCoupon((req.valid!.params as IdParam).id, req.user!.id));
});
hostCouponsRouter.patch(
  "/me/coupons/:id",
  requireAuth,
  requireRole("host"),
  validate({ params: couponIdParamSchema, body: updateCouponSchema }),
  async (req: Request, res: Response) => {
    ok(res, await updateCoupon((req.valid!.params as IdParam).id, req.valid!.body as UpdateCouponInput, req.user!.id));
  }
);
hostCouponsRouter.delete("/me/coupons/:id", requireAuth, requireRole("host"), validate({ params: couponIdParamSchema }), async (req: Request, res: Response) => {
  await deleteCoupon((req.valid!.params as IdParam).id, req.user!.id);
  ok(res, { deleted: true });
});

// -- Admin: every coupon -------------------------------------------------------------------------

export const adminCouponsRouter = Router();
adminCouponsRouter.get("/coupons", can("payments.view"), validate({ query: listCouponsQuerySchema }), async (req: Request, res: Response) => {
  const query = req.valid!.query as ListCouponsQuery;
  const { data, total } = await listCoupons(query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
});
adminCouponsRouter.post("/coupons", can("coupons.manage"), validate({ body: adminCreateCouponSchema }), async (req: Request, res: Response) => {
  const input = req.valid!.body as AdminCreateCouponInput;
  const coupon = await createCoupon(input, { type: input.owner_type, hostId: input.host_id ?? null, createdBy: req.user!.id });
  await writeAuditLog(req.user!.id, "ADMIN_CREATED_COUPON", "coupon", coupon.id, null, { code: coupon.code, owner_type: coupon.owner_type, host_id: coupon.host_id });
  created(res, coupon);
});
adminCouponsRouter.get("/coupons/:id", can("payments.view"), validate({ params: couponIdParamSchema }), async (req: Request, res: Response) => {
  ok(res, await getCoupon((req.valid!.params as IdParam).id));
});
adminCouponsRouter.patch("/coupons/:id", can("coupons.manage"), validate({ params: couponIdParamSchema, body: updateCouponSchema }), async (req: Request, res: Response) => {
  const input = req.valid!.body as UpdateCouponInput;
  const coupon = await updateCoupon((req.valid!.params as IdParam).id, input);
  await writeAuditLog(req.user!.id, "ADMIN_UPDATED_COUPON", "coupon", coupon.id, null, { code: coupon.code, changed: Object.keys(input) });
  ok(res, coupon);
});
adminCouponsRouter.delete("/coupons/:id", can("coupons.manage"), validate({ params: couponIdParamSchema }), async (req: Request, res: Response) => {
  const { id } = req.valid!.params as IdParam;
  const coupon = await getCoupon(id);
  await deleteCoupon(id);
  await writeAuditLog(req.user!.id, "ADMIN_DELETED_COUPON", "coupon", id, null, { code: coupon.code });
  ok(res, { deleted: true });
});

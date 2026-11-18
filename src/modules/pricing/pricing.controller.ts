import { Request, Response } from "express";
import { callerHasAdminPermission } from "../admin/permissions";
import { created, ok } from "../../utils/respond";
import { createPricing, deletePricing, listPricing, updatePricing } from "./pricing.service";
import { CreatePricingInput, LocationIdParam, PricingParams, UpdatePricingInput } from "./pricing.schema";
import { auditAdminListingEdit } from "../admin/audit.service";

// Admin Console: "may this caller act as an administrator here" is a team-role permission,
// not bare admin-role membership -- see src/modules/admin/permissions.ts.
async function isCallerAdmin(req: Request): Promise<boolean> {
  return callerHasAdminPermission(req, "locations.moderate");
}

export async function getPricing(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const isAdmin = req.user ? await callerHasAdminPermission(req, "locations.view") : false;
  const pricing = await listPricing(req.supabase!, req.user?.id, id, isAdmin);
  ok(res, pricing);
}

export async function postPricing(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const input = req.valid!.body as CreatePricingInput;
  const isAdmin = await isCallerAdmin(req);
  const pricing = await createPricing(req.supabase!, req.user!.id, isAdmin, id, input);
  await auditAdminListingEdit(req, id, "ADMIN_UPDATED_PRICING", { change: "created", pricing_id: pricing.id, booking_type: input.booking_type });
  created(res, pricing);
}

export async function patchPricing(req: Request, res: Response): Promise<void> {
  const { id, pricingId } = req.valid!.params as PricingParams;
  const input = req.valid!.body as UpdatePricingInput;
  const isAdmin = await isCallerAdmin(req);
  const pricing = await updatePricing(req.supabase!, req.user!.id, isAdmin, id, pricingId, input);
  await auditAdminListingEdit(req, id, "ADMIN_UPDATED_PRICING", { change: "updated", pricing_id: pricingId, fields: Object.keys(input) });
  ok(res, pricing);
}

export async function deletePricingHandler(req: Request, res: Response): Promise<void> {
  const { id, pricingId } = req.valid!.params as PricingParams;
  const isAdmin = await isCallerAdmin(req);
  await deletePricing(req.supabase!, req.user!.id, isAdmin, id, pricingId);
  await auditAdminListingEdit(req, id, "ADMIN_UPDATED_PRICING", { change: "deleted", pricing_id: pricingId });
  ok(res, { id: pricingId, deleted: true });
}

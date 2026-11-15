import { Request, Response } from "express";
import { ok } from "../../utils/respond";
import { PutBillingInput } from "./billing.schema";
import { deleteBillingProfile, getBillingProfile, putBillingProfile } from "./billing.service";

export async function getMyBilling(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const supabase = req.supabase!;

  const billing = await getBillingProfile(supabase, userId);

  ok(res, { billing });
}

export async function putMyBilling(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const supabase = req.supabase!;
  const input = req.valid!.body as PutBillingInput;

  const billing = await putBillingProfile(supabase, userId, input);

  ok(res, { billing });
}

export async function deleteMyBilling(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const supabase = req.supabase!;

  await deleteBillingProfile(supabase, userId);

  // Mirrors the cleared state a subsequent GET would report, so a client can use one code path for
  // both rather than special-casing the delete response.
  ok(res, { billing: null });
}

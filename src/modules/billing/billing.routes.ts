import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { deleteMyBilling, getMyBilling, putMyBilling } from "./billing.controller";
import { putBillingSchema } from "./billing.schema";

export const billingRouter = Router();

/**
 * Optional GST/billing details for the authenticated caller (Phase 29-17G).
 *
 * Every route is `requireAuth` and every one operates on `req.user.id` — there is deliberately no
 * `:userId` parameter anywhere, so one user's details are not addressable by another even before
 * RLS is considered. RLS (`user_billing_profiles_*_own`) is the actual enforcement; the route shape
 * simply removes the opportunity.
 *
 * Deliberately **not** nested under `GET /v1/me`: that endpoint is on the hot path at launch, role
 * resolution and profile-completion gating, and widening it would couple billing availability to
 * sign-in.
 */
billingRouter.get("/me/billing", requireAuth, getMyBilling);
billingRouter.put("/me/billing", requireAuth, validate({ body: putBillingSchema }), putMyBilling);
billingRouter.delete("/me/billing", requireAuth, deleteMyBilling);

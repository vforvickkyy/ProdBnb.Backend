import { Request, Response, Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { ok } from "../../utils/respond";
import { callerHasAdminPermission } from "../admin/permissions";
import { assertLocationManageable } from "../locations/locations.service";
import { locationIdParamSchema, type LocationIdParam } from "../locations/locations.schema";
import { getPrivateDetails, privateDetailsSchema, savePrivateDetails, type PrivateDetailsInput } from "./contacts";

/** A listing's on-site contact and arrival notes: the owner (or a moderating admin) only. */
export const contactsRouter = Router();

async function manageable(req: Request): Promise<string> {
  const { id } = req.valid!.params as LocationIdParam;
  await assertLocationManageable(req.supabase!, req.user!.id, await callerHasAdminPermission(req, "locations.moderate"), id);
  return id;
}

contactsRouter.get("/locations/:id/private-details", requireAuth, validate({ params: locationIdParamSchema }), async (req: Request, res: Response) => {
  ok(res, await getPrivateDetails(await manageable(req)));
});

contactsRouter.put(
  "/locations/:id/private-details",
  requireAuth,
  validate({ params: locationIdParamSchema, body: privateDetailsSchema }),
  async (req: Request, res: Response) => {
    ok(res, await savePrivateDetails(await manageable(req), req.valid!.body as PrivateDetailsInput));
  }
);

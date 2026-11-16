import { Request, Response, Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { requireRole } from "../../middleware/requireRole";
import { validate } from "../../middleware/validate";
import { ok } from "../../utils/respond";
import { requirePermission as can } from "../admin/permissions";
import { hostEarnings } from "./earnings.service";
import {
  HostIdParam,
  hostIdParamSchema,
  ListPayoutsQuery,
  listPayoutsQuerySchema,
  RecordPayoutInput,
  recordPayoutSchema,
  SavePayoutAccountInput,
  savePayoutAccountSchema,
} from "./payouts.schema";
import {
  adminHostEarnings,
  getPayoutAccount,
  listDue,
  listPayouts,
  recordPayout,
  removePayoutAccount,
  revealPayoutAccount,
  savePayoutAccount,
} from "./payouts.service";
import { z } from "zod";

/** Host side (website host area and apps): the signed-in host's own money only. */
export const hostPayoutsRouter = Router();

hostPayoutsRouter.get("/me/earnings", requireAuth, async (req: Request, res: Response) => {
  ok(res, await hostEarnings(req.user!.id));
});
hostPayoutsRouter.get("/me/payouts", requireAuth, async (req: Request, res: Response) => {
  const { data } = await listPayouts({ host_id: req.user!.id, page: 1, pageSize: 100 });
  ok(res, data);
});
hostPayoutsRouter.get("/me/payout-account", requireAuth, async (req: Request, res: Response) => {
  ok(res, await getPayoutAccount(req.user!.id));
});
hostPayoutsRouter.put(
  "/me/payout-account",
  requireAuth,
  requireRole("host"),
  validate({ body: savePayoutAccountSchema }),
  async (req: Request, res: Response) => {
    ok(res, await savePayoutAccount(req.user!.id, req.valid!.body as SavePayoutAccountInput));
  }
);
hostPayoutsRouter.delete("/me/payout-account", requireAuth, async (req: Request, res: Response) => {
  ok(res, { removed: await removePayoutAccount(req.user!.id) });
});

/** Admin side. Mounted inside the admin router (already admin-gated). */
export const adminPayoutsRouter = Router();

adminPayoutsRouter.get("/payouts/due", can("payments.view"), async (_req: Request, res: Response) => {
  ok(res, await listDue());
});
adminPayoutsRouter.get("/payouts", can("payments.view"), validate({ query: listPayoutsQuerySchema }), async (req: Request, res: Response) => {
  const query = req.valid!.query as ListPayoutsQuery;
  const { data, total } = await listPayouts(query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
});
adminPayoutsRouter.get("/hosts/:id/earnings", can("payments.view"), validate({ params: hostIdParamSchema }), async (req: Request, res: Response) => {
  ok(res, await adminHostEarnings((req.valid!.params as HostIdParam).id));
});
export const revealSchema = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict().default({});
adminPayoutsRouter.post(
  "/hosts/:id/payout-account/reveal",
  can("payments.refund"),
  validate({ params: hostIdParamSchema, body: revealSchema }),
  async (req: Request, res: Response) => {
    const body = req.valid!.body as z.infer<typeof revealSchema>;
    ok(res, await revealPayoutAccount(req.user!.id, (req.valid!.params as HostIdParam).id, body.reason ?? null));
  }
);
adminPayoutsRouter.post(
  "/hosts/:id/payouts",
  can("payments.refund"),
  validate({ params: hostIdParamSchema, body: recordPayoutSchema }),
  async (req: Request, res: Response) => {
    ok(res, await recordPayout(req.user!.id, (req.valid!.params as HostIdParam).id, req.valid!.body as RecordPayoutInput), 201);
  }
);

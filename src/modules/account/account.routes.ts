import express, { Request, Response, Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { created, ok } from "../../utils/respond";
import { requirePermission as can } from "../admin/permissions";
import { bookingIdParamSchema } from "../bookings/bookings.schema";
import {
  AdminDeletionRequestsQuery,
  adminDeletionRequestsQuerySchema,
  AdminRefundRequestsQuery,
  adminRefundRequestsQuerySchema,
  ApproveRefundRequestInput,
  approveRefundRequestSchema,
  AVATAR_MAX_BYTES,
  CompleteDeletionInput,
  completeDeletionSchema,
  CreateRefundRequestInput,
  createRefundRequestSchema,
  DeclineInput,
  declineSchema,
  DeletionRequestInput,
  deletionRequestSchema,
  IdParam,
  idParamSchema,
  MyPaymentsQuery,
  myPaymentsQuerySchema,
  MyRefundRequestsQuery,
  myRefundRequestsQuerySchema,
} from "./account.schema";
import {
  completeDeletion,
  declineDeletion,
  deletionBlockers,
  getMyDeletionRequest,
  listAdminDeletionRequests,
  requestDeletion,
  withdrawDeletion,
} from "./deletion.service";
import { listMyPayments, uploadAvatar } from "./myPayments.service";
import {
  approveRefundRequest,
  createBookerRefundRequest,
  declineRefundRequest,
  listAdminRefundRequests,
  listMyRefundRequests,
  withdrawRefundRequest,
} from "./refundRequests.service";

/** Booker account (website and apps). Every route acts only on the signed-in user's own data. */
export const accountRouter = Router();

accountRouter.get("/me/payments", requireAuth, validate({ query: myPaymentsQuerySchema }), async (req: Request, res: Response) => {
  const query = req.valid!.query as MyPaymentsQuery;
  const { data, total } = await listMyPayments(req.user!.id, query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
});

accountRouter.get("/me/refund-requests", requireAuth, validate({ query: myRefundRequestsQuerySchema }), async (req: Request, res: Response) => {
  ok(res, await listMyRefundRequests(req.user!.id, (req.valid!.query as MyRefundRequestsQuery).booking_id));
});
accountRouter.post(
  "/bookings/:id/refund-requests",
  requireAuth,
  validate({ params: bookingIdParamSchema, body: createRefundRequestSchema }),
  async (req: Request, res: Response) => {
    const { id } = req.valid!.params as { id: string };
    created(res, await createBookerRefundRequest(req.user!.id, id, (req.valid!.body as CreateRefundRequestInput).reason));
  }
);
accountRouter.post("/refund-requests/:id/withdraw", requireAuth, validate({ params: idParamSchema }), async (req: Request, res: Response) => {
  ok(res, await withdrawRefundRequest(req.user!.id, (req.valid!.params as IdParam).id));
});

accountRouter.get("/me/deletion-request", requireAuth, async (req: Request, res: Response) => {
  const [request, blockers] = await Promise.all([getMyDeletionRequest(req.user!.id), deletionBlockers(req.user!.id)]);
  ok(res, { request, blockers });
});
accountRouter.post("/me/deletion-request", requireAuth, validate({ body: deletionRequestSchema }), async (req: Request, res: Response) => {
  created(res, await requestDeletion(req.user!.id, (req.valid!.body as DeletionRequestInput).reason ?? null));
});
accountRouter.delete("/me/deletion-request", requireAuth, async (req: Request, res: Response) => {
  ok(res, await withdrawDeletion(req.user!.id));
});

// The image arrives as the raw body (Content-Type image/jpeg|png|webp), so this route parses its
// own body: the global JSON parser leaves non-JSON bodies alone.
accountRouter.post(
  "/me/avatar",
  requireAuth,
  express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: AVATAR_MAX_BYTES }),
  async (req: Request, res: Response) => {
    ok(res, { avatar_url: await uploadAvatar(req.user!.id, req.header("content-type"), req.body) });
  }
);

/** Admin side. Mounted inside the admin router (already admin-gated). */
export const adminAccountRouter = Router();

adminAccountRouter.get("/refund-requests", can("payments.view"), validate({ query: adminRefundRequestsQuerySchema }), async (req: Request, res: Response) => {
  const query = req.valid!.query as AdminRefundRequestsQuery;
  const { data, total } = await listAdminRefundRequests(query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
});
adminAccountRouter.post(
  "/refund-requests/:id/approve",
  can("payments.refund"),
  validate({ params: idParamSchema, body: approveRefundRequestSchema }),
  async (req: Request, res: Response) => {
    ok(res, await approveRefundRequest(req.user!.id, (req.valid!.params as IdParam).id, req.valid!.body as ApproveRefundRequestInput));
  }
);
adminAccountRouter.post(
  "/refund-requests/:id/decline",
  can("payments.refund"),
  validate({ params: idParamSchema, body: declineSchema }),
  async (req: Request, res: Response) => {
    ok(res, await declineRefundRequest(req.user!.id, (req.valid!.params as IdParam).id, (req.valid!.body as DeclineInput).note));
  }
);

adminAccountRouter.get("/deletion-requests", can("users.view"), validate({ query: adminDeletionRequestsQuerySchema }), async (req: Request, res: Response) => {
  const query = req.valid!.query as AdminDeletionRequestsQuery;
  const { data, total } = await listAdminDeletionRequests(query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
});
adminAccountRouter.post(
  "/deletion-requests/:id/complete",
  can("users.manage"),
  validate({ params: idParamSchema, body: completeDeletionSchema }),
  async (req: Request, res: Response) => {
    ok(res, await completeDeletion(req.user!.id, (req.valid!.params as IdParam).id, (req.valid!.body as CompleteDeletionInput).note ?? null));
  }
);
adminAccountRouter.post(
  "/deletion-requests/:id/decline",
  can("users.manage"),
  validate({ params: idParamSchema, body: declineSchema }),
  async (req: Request, res: Response) => {
    ok(res, await declineDeletion(req.user!.id, (req.valid!.params as IdParam).id, (req.valid!.body as DeclineInput).note));
  }
);

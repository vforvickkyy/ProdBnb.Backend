import { Request, Response, Router } from "express";
import { clientInfo } from "../../lib/clientInfo";
import { requireAuth } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { created, ok } from "../../utils/respond";
import { requirePermission as can } from "../admin/permissions";
import {
  AdminHostRequestsQuery,
  adminHostRequestsQuerySchema,
  HostRequestIdParam,
  hostRequestIdParamSchema,
  HostRequestInput,
  hostRequestSchema,
  UpdateHostRequestInput,
  updateHostRequestSchema,
} from "./hostRequests.schema";
import {
  getMyHostRequest,
  hostRequestSummary,
  HostRequestSource,
  listAdminHostRequests,
  submitHostRequest,
  updateHostRequest,
  withdrawHostRequest,
} from "./hostRequests.service";

/** "Request a callback" to get help listing a place. Signed-in people, their own request only. */
export const hostRequestsRouter = Router();

function sourceOf(req: Request): HostRequestSource {
  const platform = clientInfo(req).platform;
  return platform === "ios" || platform === "android" ? platform : "web";
}

hostRequestsRouter.get("/me/host-request", requireAuth, async (req: Request, res: Response) => {
  ok(res, await getMyHostRequest(req.user!.id));
});

hostRequestsRouter.post("/me/host-request", requireAuth, validate({ body: hostRequestSchema }), async (req: Request, res: Response) => {
  const { request, created: isNew } = await submitHostRequest(req.user!, req.valid!.body as HostRequestInput, sourceOf(req));
  if (isNew) {
    created(res, request);
  } else {
    ok(res, request);
  }
});

hostRequestsRouter.delete("/me/host-request", requireAuth, async (req: Request, res: Response) => {
  ok(res, await withdrawHostRequest(req.user!.id));
});

/** Admin side. Mounted inside the admin router (already admin-gated). */
export const adminHostRequestsRouter = Router();

adminHostRequestsRouter.get(
  "/host-requests",
  can("host_requests.manage"),
  validate({ query: adminHostRequestsQuerySchema }),
  async (req: Request, res: Response) => {
    const query = req.valid!.query as AdminHostRequestsQuery;
    const { data, total } = await listAdminHostRequests(query);
    ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
  }
);

adminHostRequestsRouter.get("/host-requests/summary", can("host_requests.manage"), async (_req: Request, res: Response) => {
  ok(res, await hostRequestSummary());
});

adminHostRequestsRouter.patch(
  "/host-requests/:id",
  can("host_requests.manage"),
  validate({ params: hostRequestIdParamSchema, body: updateHostRequestSchema }),
  async (req: Request, res: Response) => {
    const { id } = req.valid!.params as HostRequestIdParam;
    ok(res, await updateHostRequest(req.user!.id, id, req.valid!.body as UpdateHostRequestInput));
  }
);

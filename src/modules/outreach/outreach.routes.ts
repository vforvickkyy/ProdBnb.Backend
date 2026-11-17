import express, { Request, Response, Router } from "express";
import { created, ok } from "../../utils/respond";
import { writeAuditLog } from "../admin/audit.service";
import { renderPreview } from "./campaigns.service";
import { audienceOptions, createTemplate, deleteTemplate, getTemplate, listTemplates, updateTemplate } from "./templates.service";
import { VARIABLES } from "./templating";
import { validate } from "../../middleware/validate";
import { requirePermission as can } from "../admin/permissions";
import {
  deleteCampaignHandler,
  deleteChannelHandler,
  getCampaignHandler,
  getCampaignRecipientsHandler,
  getCampaignsHandler,
  getJobsHandler,
  getMessagingOverviewHandler,
  getUnsubscribeHandler,
  getWebPushKeyHandler,
  patchCampaignHandler,
  patchChannelHandler,
  postAudiencePreviewHandler,
  postCampaignHandler,
  postCancelCampaignHandler,
  postDispatchJobsHandler,
  postProcessCampaignHandler,
  postSendCampaignHandler,
  postTestCampaignHandler,
  postTestChannelHandler,
  postUnsubscribeHandler,
  putChannelHandler,
  putJobsHandler,
} from "./outreach.controller";
import {
  audiencePreviewSchema,
  campaignIdParamSchema,
  campaignRecipientsQuerySchema,
  createTemplateSchema,
  renderPreviewSchema,
  templateIdParamSchema,
  updateTemplateSchema,
  type CreateTemplateInput,
  type RenderPreviewInput,
  type TemplateIdParam,
  type UpdateTemplateInput,
  channelEnabledSchema,
  channelParamSchema,
  createCampaignSchema,
  jobsConfigSchema,
  listCampaignsQuerySchema,
  saveChannelSchema,
  sendCampaignSchema,
  testCampaignSchema,
  testChannelSchema,
  unsubscribeQuerySchema,
  updateCampaignSchema,
} from "./outreach.schema";

/** Admin Console 2 messaging. Mounted inside adminRouter (already admin-gated). */
export const adminOutreachRouter = Router();

adminOutreachRouter.get("/messaging/overview", can("campaigns.view"), getMessagingOverviewHandler);
adminOutreachRouter.put(
  "/messaging/channels/:channel",
  can("channels.manage"),
  validate({ params: channelParamSchema, body: saveChannelSchema }),
  putChannelHandler
);
adminOutreachRouter.patch(
  "/messaging/channels/:channel",
  can("channels.manage"),
  validate({ params: channelParamSchema, body: channelEnabledSchema }),
  patchChannelHandler
);
adminOutreachRouter.delete("/messaging/channels/:channel", can("channels.manage"), validate({ params: channelParamSchema }), deleteChannelHandler);
adminOutreachRouter.post(
  "/messaging/channels/:channel/test",
  can("channels.manage"),
  validate({ params: channelParamSchema, body: testChannelSchema }),
  postTestChannelHandler
);
adminOutreachRouter.get("/messaging/jobs", can("campaigns.view"), getJobsHandler);
adminOutreachRouter.put("/messaging/jobs", can("channels.manage"), validate({ body: jobsConfigSchema }), putJobsHandler);

// -- Templates, variables and personalised previews ------------------------------------------------

adminOutreachRouter.get("/notification-templates", can("campaigns.view"), async (_req: Request, res: Response) => {
  ok(res, await listTemplates());
});
adminOutreachRouter.post("/notification-templates", can("campaigns.send"), validate({ body: createTemplateSchema }), async (req: Request, res: Response) => {
  const t = await createTemplate(req.user!.id, req.valid!.body as CreateTemplateInput);
  await writeAuditLog(req.user!.id, "ADMIN_CREATED_NOTIFICATION_TEMPLATE", "notification_template", t.id, null, { name: t.name });
  created(res, t);
});
adminOutreachRouter.get("/notification-templates/:templateId", can("campaigns.view"), validate({ params: templateIdParamSchema }), async (req: Request, res: Response) => {
  ok(res, await getTemplate((req.valid!.params as TemplateIdParam).templateId));
});
adminOutreachRouter.patch(
  "/notification-templates/:templateId",
  can("campaigns.send"),
  validate({ params: templateIdParamSchema, body: updateTemplateSchema }),
  async (req: Request, res: Response) => {
    const input = req.valid!.body as UpdateTemplateInput;
    const t = await updateTemplate(req.user!.id, (req.valid!.params as TemplateIdParam).templateId, input);
    await writeAuditLog(req.user!.id, "ADMIN_UPDATED_NOTIFICATION_TEMPLATE", "notification_template", t.id, null, { name: t.name, fields: Object.keys(input) });
    ok(res, t);
  }
);
adminOutreachRouter.delete("/notification-templates/:templateId", can("campaigns.send"), validate({ params: templateIdParamSchema }), async (req: Request, res: Response) => {
  const t = await deleteTemplate((req.valid!.params as TemplateIdParam).templateId);
  await writeAuditLog(req.user!.id, "ADMIN_DELETED_NOTIFICATION_TEMPLATE", "notification_template", t.id, null, { name: t.name });
  ok(res, { deleted: true });
});
adminOutreachRouter.get("/notification-variables", can("campaigns.view"), (_req: Request, res: Response) => {
  ok(res, VARIABLES);
});
adminOutreachRouter.post("/campaigns/render-preview", can("campaigns.view"), validate({ body: renderPreviewSchema }), async (req: Request, res: Response) => {
  ok(res, await renderPreview(req.user!.id, req.valid!.body as RenderPreviewInput));
});
adminOutreachRouter.get("/campaigns/audience-options", can("campaigns.view"), async (_req: Request, res: Response) => {
  ok(res, await audienceOptions());
});

adminOutreachRouter.get("/campaigns", can("campaigns.view"), validate({ query: listCampaignsQuerySchema }), getCampaignsHandler);
adminOutreachRouter.post("/campaigns", can("campaigns.send"), validate({ body: createCampaignSchema }), postCampaignHandler);
adminOutreachRouter.post("/campaigns/audience-preview", can("campaigns.view"), validate({ body: audiencePreviewSchema }), postAudiencePreviewHandler);
adminOutreachRouter.post("/campaigns/test", can("campaigns.send"), validate({ body: testCampaignSchema }), postTestCampaignHandler);
adminOutreachRouter.get("/campaigns/:campaignId", can("campaigns.view"), validate({ params: campaignIdParamSchema }), getCampaignHandler);
adminOutreachRouter.patch(
  "/campaigns/:campaignId",
  can("campaigns.send"),
  validate({ params: campaignIdParamSchema, body: updateCampaignSchema }),
  patchCampaignHandler
);
adminOutreachRouter.delete("/campaigns/:campaignId", can("campaigns.send"), validate({ params: campaignIdParamSchema }), deleteCampaignHandler);
adminOutreachRouter.post(
  "/campaigns/:campaignId/send",
  can("campaigns.send"),
  validate({ params: campaignIdParamSchema, body: sendCampaignSchema }),
  postSendCampaignHandler
);
adminOutreachRouter.post("/campaigns/:campaignId/cancel", can("campaigns.send"), validate({ params: campaignIdParamSchema }), postCancelCampaignHandler);
adminOutreachRouter.post("/campaigns/:campaignId/process", can("campaigns.send"), validate({ params: campaignIdParamSchema }), postProcessCampaignHandler);
adminOutreachRouter.get(
  "/campaigns/:campaignId/recipients",
  can("campaigns.view"),
  validate({ params: campaignIdParamSchema, query: campaignRecipientsQuerySchema }),
  getCampaignRecipientsHandler
);

/** Public, unauthenticated. Mounted at /v1. */
export const publicOutreachRouter = Router();

publicOutreachRouter.get("/email/unsubscribe", validate({ query: unsubscribeQuerySchema }), getUnsubscribeHandler);
// Mail clients send the RFC 8058 one-click POST as application/x-www-form-urlencoded.
publicOutreachRouter.post(
  "/email/unsubscribe",
  express.urlencoded({ extended: false, limit: "2kb" }),
  validate({ query: unsubscribeQuerySchema }),
  postUnsubscribeHandler
);
publicOutreachRouter.post("/internal/jobs/dispatch", postDispatchJobsHandler);
publicOutreachRouter.get("/push/web/public-key", getWebPushKeyHandler);

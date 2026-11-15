import express, { Router } from "express";
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

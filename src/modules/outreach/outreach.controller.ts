import { processEmailOutbox } from "../email/outbox.service";
import { timingSafeEqual } from "crypto";
import { Request, Response } from "express";
import { UnauthenticatedError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { created, ok } from "../../utils/respond";
import { writeAuditLog } from "../admin/audit.service";
import { createAnnouncementNotification, deliverPush } from "../notifications/notification.service";
import {
  apiBaseUrl,
  cancelCampaign,
  channelReadiness,
  createCampaign,
  deleteDraftCampaign,
  getCampaign,
  listCampaignRecipients,
  listCampaigns,
  previewAudience,
  processCampaign,
  runCampaignDispatch,
  sendCampaign,
  sendTestToSelf,
  updateCampaign,
} from "./campaigns.service";
import { listChannels, recordTestResult, removeChannel, saveChannel, setChannelEnabled, verifyPushCredentials, webPushPublicKey } from "./channels.service";
import { renderEmailBody, sendEmail, verifySmtp, verifyUnsubscribeToken, wrapEmail } from "./email";
import {
  AudiencePreviewInput,
  CampaignIdParam,
  CampaignRecipientsQuery,
  ChannelEnabledInput,
  ChannelParam,
  CreateCampaignInput,
  JobsConfigInput,
  ListCampaignsQuery,
  SaveChannelInput,
  SendCampaignInput,
  TestCampaignInput,
  TestChannelInput,
  UnsubscribeQuery,
  UpdateCampaignInput,
} from "./outreach.schema";
import { env } from "../../config/env";
import { escapeHtml } from "../../utils/html";

// -- Overview ---------------------------------------------------------------------------------------

async function deviceCounts(): Promise<{ ios: number; android: number; web: number }> {
  const counts = { ios: 0, android: 0, web: 0 };
  await Promise.all(
    (["ios", "android", "web"] as const).map(async (platform) => {
      const { count, error } = await adminClient
        .from("user_devices")
        .select("id", { count: "exact", head: true })
        .eq("platform", platform)
        .eq("is_active", true);
      if (error) {
        throw error;
      }
      counts[platform] = count ?? 0;
    })
  );
  return counts;
}

async function jobsStatus() {
  const [{ data: cfg, error }, { data: health, error: healthError }] = await Promise.all([
    adminClient
      .from("background_jobs_config")
      .select("id, dispatch_url, enabled, last_tick_at, last_run_at, last_run_ok, last_run_summary, updated_at")
      .eq("singleton", true)
      .single(),
    adminClient.rpc("admin_jobs_health"),
  ]);
  if (error) {
    throw error;
  }
  if (healthError) {
    throw healthError;
  }
  return {
    ...(cfg as Record<string, unknown>),
    suggested_url: `${apiBaseUrl()}/v1/internal/jobs/dispatch`,
    health: health as { pg_net: boolean; pg_cron: boolean; dispatch_job_scheduled: boolean },
  };
}

export async function getMessagingOverviewHandler(_req: Request, res: Response): Promise<void> {
  const [channels, readiness, devices, jobs] = await Promise.all([listChannels(), channelReadiness(), deviceCounts(), jobsStatus()]);
  ok(res, { channels, readiness, devices, jobs });
}

// -- Channels ---------------------------------------------------------------------------------------

export async function putChannelHandler(req: Request, res: Response): Promise<void> {
  const { channel } = req.valid!.params as ChannelParam;
  const input = req.valid!.body as SaveChannelInput;
  if (input.channel !== channel) {
    throw new ValidationError("The body's channel must match the URL.");
  }
  ok(res, await saveChannel(req.user!.id, input));
}

export async function patchChannelHandler(req: Request, res: Response): Promise<void> {
  const { channel } = req.valid!.params as ChannelParam;
  const { enabled } = req.valid!.body as ChannelEnabledInput;
  ok(res, await setChannelEnabled(req.user!.id, channel, enabled));
}

export async function deleteChannelHandler(req: Request, res: Response): Promise<void> {
  const { channel } = req.valid!.params as ChannelParam;
  await removeChannel(req.user!.id, channel);
  ok(res, { removed: true });
}

export async function postTestChannelHandler(req: Request, res: Response): Promise<void> {
  const { channel } = req.valid!.params as ChannelParam;
  const input = req.valid!.body as TestChannelInput;

  if (channel === "smtp") {
    const verified = await verifySmtp();
    if (!verified.ok) {
      await recordTestResult(channel, false, verified.detail);
      ok(res, verified);
      return;
    }
    const to = input.to ?? req.user!.email;
    if (!to) {
      throw new ValidationError("Your admin account has no email address -- pass `to`.");
    }
    try {
      const rendered = renderEmailBody(
        `This is a test email from the ${env.BRAND_NAME} Admin Console.\n\nIf you can read this, your SMTP connection works.`
      );
      const subject = `${env.BRAND_NAME} test email`;
      const email = wrapEmail({ subject, bodyHtml: rendered.html, bodyText: rendered.text });
      await sendEmail({ to, subject, html: email.html, text: email.text });
      await recordTestResult(channel, true, null);
      ok(res, { ok: true, detail: `Test email sent to ${to}.` });
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 300) : "Sending failed.";
      await recordTestResult(channel, false, detail);
      ok(res, { ok: false, detail });
    }
    return;
  }

  const platform = channel === "apns" ? "ios" : channel === "fcm" ? "android" : "web";
  const credentials = await verifyPushCredentials(channel);
  if (!credentials.ok) {
    await recordTestResult(channel, false, credentials.detail);
    ok(res, credentials);
    return;
  }

  // A real delivery needs a real device. Only the admin's OWN devices are eligible, so a test can
  // never land on a customer's phone.
  let query = adminClient
    .from("user_devices")
    .select("id")
    .eq("user_id", req.user!.id)
    .eq("platform", platform)
    .eq("is_active", true);
  if (input.device_id) {
    query = query.eq("id", input.device_id);
  }
  const { data: devices, error } = await query;
  if (error) {
    throw error;
  }
  if (!devices || devices.length === 0) {
    await recordTestResult(channel, true, null);
    ok(res, {
      ok: true,
      detail: `${credentials.detail} No ${platform} device is registered to your account, so nothing was delivered -- sign in to the app on a device to test delivery end to end.`,
    });
    return;
  }
  const notification = await createAnnouncementNotification({
    userId: req.user!.id,
    campaignId: crypto.randomUUID(),
    title: `${env.BRAND_NAME} test notification`,
    body: "If you can see this, push delivery works.",
    linkUrl: null,
  });
  const result = await deliverPush(notification, { platforms: [platform] });
  const delivered = result.sent > 0;
  const detail = delivered
    ? `Delivered to ${result.sent} of your ${platform} device(s).`
    : `Credentials are valid but delivery failed on ${result.failed} device(s) -- see Notification diagnostics.`;
  await recordTestResult(channel, delivered, delivered ? null : detail);
  ok(res, { ok: delivered, detail });
}

// -- Background jobs ---------------------------------------------------------------------------------

export async function getJobsHandler(_req: Request, res: Response): Promise<void> {
  ok(res, await jobsStatus());
}

export async function putJobsHandler(req: Request, res: Response): Promise<void> {
  const input = req.valid!.body as JobsConfigInput;
  const { data, error } = await adminClient
    .from("background_jobs_config")
    .update({ ...input, updated_by: req.user!.id })
    .eq("singleton", true)
    .select("id")
    .single();
  if (error) {
    throw error;
  }
  await writeAuditLog(req.user!.id, "ADMIN_UPDATED_JOBS_CONFIG", "settings", (data as { id: string }).id, null, input);
  ok(res, await jobsStatus());
}

// -- Campaigns ---------------------------------------------------------------------------------------

export async function getCampaignsHandler(req: Request, res: Response): Promise<void> {
  const query = req.valid!.query as ListCampaignsQuery;
  const { data, total } = await listCampaigns(query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
}

export async function postCampaignHandler(req: Request, res: Response): Promise<void> {
  created(res, await createCampaign(req.user!.id, req.valid!.body as CreateCampaignInput));
}

export async function getCampaignHandler(req: Request, res: Response): Promise<void> {
  const { campaignId } = req.valid!.params as CampaignIdParam;
  ok(res, await getCampaign(campaignId));
}

export async function patchCampaignHandler(req: Request, res: Response): Promise<void> {
  const { campaignId } = req.valid!.params as CampaignIdParam;
  ok(res, await updateCampaign(campaignId, req.valid!.body as UpdateCampaignInput));
}

export async function deleteCampaignHandler(req: Request, res: Response): Promise<void> {
  const { campaignId } = req.valid!.params as CampaignIdParam;
  await deleteDraftCampaign(campaignId);
  ok(res, { deleted: true });
}

export async function postSendCampaignHandler(req: Request, res: Response): Promise<void> {
  const { campaignId } = req.valid!.params as CampaignIdParam;
  const { scheduled_at } = req.valid!.body as SendCampaignInput;
  ok(res, await sendCampaign(req.user!.id, campaignId, scheduled_at));
}

export async function postCancelCampaignHandler(req: Request, res: Response): Promise<void> {
  const { campaignId } = req.valid!.params as CampaignIdParam;
  ok(res, await cancelCampaign(req.user!.id, campaignId));
}

/** The campaign page calls this every few seconds while a campaign is sending -- it advances it. */
export async function postProcessCampaignHandler(req: Request, res: Response): Promise<void> {
  const { campaignId } = req.valid!.params as CampaignIdParam;
  await processCampaign(campaignId, Date.now() + 8_000);
  ok(res, await getCampaign(campaignId));
}

export async function getCampaignRecipientsHandler(req: Request, res: Response): Promise<void> {
  const { campaignId } = req.valid!.params as CampaignIdParam;
  const query = req.valid!.query as CampaignRecipientsQuery;
  const { data, total } = await listCampaignRecipients(campaignId, query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
}

export async function postAudiencePreviewHandler(req: Request, res: Response): Promise<void> {
  ok(res, await previewAudience(req.valid!.body as AudiencePreviewInput));
}

export async function postTestCampaignHandler(req: Request, res: Response): Promise<void> {
  ok(res, await sendTestToSelf(req.user!.id, req.user!.email, req.valid!.body as TestCampaignInput));
}

// -- Public: unsubscribe, job dispatch, web push key ---------------------------------------------------

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f5;color:#18181b;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
main{background:#fff;border-radius:12px;padding:32px;max-width:420px;width:100%;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 12px}p{line-height:1.6;color:#3f3f46}
button{background:#C28014;color:#fff;border:0;border-radius:8px;padding:12px 18px;font-size:15px;font-weight:600;cursor:pointer}</style></head><body><main>${body}</main></body></html>`;
}

/** GET shows a confirmation button -- mail scanners prefetch GET links, so GET never unsubscribes. */
export async function getUnsubscribeHandler(req: Request, res: Response): Promise<void> {
  const { token } = req.valid!.query as UnsubscribeQuery;
  const email = await verifyUnsubscribeToken(token);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!email) {
    res.status(400).send(page("Link expired", "<h1>This link is not valid</h1><p>It may have been copied incompletely.</p>"));
    return;
  }
  res.status(200).send(
    page(
      "Unsubscribe",
      `<h1>Unsubscribe from ${escapeHtml(env.BRAND_NAME)} announcements?</h1><p>You will still receive emails about your own bookings and account.</p>
<form method="post" action="?token=${encodeURIComponent(token)}"><button type="submit">Unsubscribe</button></form>`
    )
  );
}

/** POST (the button, or a mail client's RFC 8058 one-click request) records the suppression. */
export async function postUnsubscribeHandler(req: Request, res: Response): Promise<void> {
  const { token } = req.valid!.query as UnsubscribeQuery;
  const email = await verifyUnsubscribeToken(token);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!email) {
    res.status(400).send(page("Link expired", "<h1>This link is not valid</h1>"));
    return;
  }
  const { error } = await adminClient
    .from("email_suppressions")
    .upsert({ email: email.toLowerCase(), reason: "unsubscribed" }, { onConflict: "email", ignoreDuplicates: true });
  if (error) {
    throw error;
  }
  res.status(200).send(page("Unsubscribed", `<h1>You're unsubscribed</h1><p>You won't receive ${escapeHtml(env.BRAND_NAME)} announcement emails any more.</p>`));
}

let jobsSecret: string | null = null;

/** POST /v1/internal/jobs/dispatch -- called every minute by pg_cron (via pg_net) with a shared secret. */
export async function postDispatchJobsHandler(req: Request, res: Response): Promise<void> {
  if (!jobsSecret) {
    const { data, error } = await adminClient.rpc("system_secret", { _name: "prodbnb_jobs_secret" });
    if (error || typeof data !== "string") {
      throw error ?? new Error("Job secret is missing.");
    }
    jobsSecret = data;
  }
  const presented = Buffer.from(req.header("x-prodbnb-job-secret") ?? "");
  const expected = Buffer.from(jobsSecret);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    throw new UnauthenticatedError("Invalid job secret.");
  }

  const startedAt = new Date().toISOString();
  try {
    const campaigns = await runCampaignDispatch(Date.now() + 18_000);
    // Transactional emails that couldn't go straight away (retries), in the time left.
    const emails = await processEmailOutbox(Date.now() + 7_000).catch((e) => ({ error: e instanceof Error ? e.message.slice(0, 200) : "failed" }));
    const summary = { ...campaigns, emails };
    await adminClient
      .from("background_jobs_config")
      .update({ last_run_at: startedAt, last_run_ok: true, last_run_summary: summary })
      .eq("singleton", true);
    ok(res, summary);
  } catch (error) {
    await adminClient
      .from("background_jobs_config")
      .update({
        last_run_at: startedAt,
        last_run_ok: false,
        last_run_summary: { error: error instanceof Error ? error.message.slice(0, 300) : "failed" },
      })
      .eq("singleton", true);
    throw error;
  }
}

export async function getWebPushKeyHandler(_req: Request, res: Response): Promise<void> {
  ok(res, { public_key: await webPushPublicKey() });
}

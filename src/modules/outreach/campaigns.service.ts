import { NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { writeAuditLog } from "../admin/audit.service";
import { createAnnouncementNotification, deliverPush, NotificationDetail } from "../notifications/notification.service";
import { listChannels } from "./channels.service";
import { renderEmailBody, sendEmail, unsubscribeToken, wrapEmail } from "./email";
import { checkVariables, loadContext, personVars, renderFor, VARIABLES, type CampaignContext, type RenderableContent } from "./templating";
import {
  Audience,
  AudiencePreviewInput,
  CampaignRecipientsQuery,
  CreateCampaignInput,
  ListCampaignsQuery,
  RenderPreviewInput,
  TestCampaignInput,
  UpdateCampaignInput,
} from "./outreach.schema";

/**
 * Admin Console 2: announcements (to everyone / a role / everyone on a platform) and direct
 * notifications (to chosen people), over any mix of in-app, push and email.
 *
 * Lifecycle: draft -> (scheduled ->) sending -> sent, or cancelled at any point before sent.
 * "Sending" expands the audience ONCE into campaign_recipients (in SQL), then processes recipients
 * in small leased batches -- inline for a few seconds after the admin presses Send, while the
 * campaign page is open, and every minute from pg_cron through the job dispatcher. Each recipient
 * is processed once: a retry after a crash re-finds the same in-app row (idempotency key) instead
 * of duplicating it.
 *
 * Push always implies an in-app record: the in-app row is what a push delivery attempt is logged
 * against, and it is what the user finds in their inbox after dismissing the banner.
 */

const COLUMNS =
  "id, name, kind, channels, platforms, audience, title, body, link_url, email_subject, email_body, location_id, coupon_id, template_id, status, " +
  "scheduled_at, started_at, completed_at, recipient_count, last_error, created_by, sent_by, created_at, updated_at";

export type CampaignStatus = "draft" | "scheduled" | "sending" | "sent" | "cancelled" | "failed";

export interface CampaignRow {
  id: string;
  name: string;
  kind: "announcement" | "direct";
  channels: ("in_app" | "push" | "email")[];
  platforms: ("ios" | "android" | "web")[];
  audience: Audience;
  title: string;
  body: string;
  link_url: string | null;
  email_subject: string | null;
  email_body: string | null;
  location_id: string | null;
  coupon_id: string | null;
  template_id: string | null;
  status: CampaignStatus;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  recipient_count: number | null;
  last_error: string | null;
  created_by: string | null;
  sent_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignStats {
  total: number;
  processed: number;
  in_app_created: number;
  push_sent: number;
  push_failed: number;
  push_no_devices: number;
  push_opted_out: number;
  email_sent: number;
  email_failed: number;
  email_unsubscribed: number;
  email_missing: number;
}

export interface CampaignView extends CampaignRow {
  stats: CampaignStats;
}

const EMPTY_STATS: CampaignStats = {
  total: 0,
  processed: 0,
  in_app_created: 0,
  push_sent: 0,
  push_failed: 0,
  push_no_devices: 0,
  push_opted_out: 0,
  email_sent: 0,
  email_failed: 0,
  email_unsubscribed: 0,
  email_missing: 0,
};

function normalizeChannels(channels: CampaignRow["channels"]): CampaignRow["channels"] {
  const set = new Set(channels);
  if (set.has("push")) {
    set.add("in_app");
  }
  return (["in_app", "push", "email"] as const).filter((c) => set.has(c));
}

async function statsFor(ids: string[]): Promise<Map<string, CampaignStats>> {
  const result = new Map<string, CampaignStats>();
  if (ids.length === 0) {
    return result;
  }
  const { data, error } = await adminClient.rpc("admin_campaign_stats", { _campaign_ids: ids });
  if (error) {
    throw error;
  }
  for (const row of (data ?? []) as (CampaignStats & { campaign_id: string })[]) {
    const { campaign_id, ...stats } = row;
    result.set(
      campaign_id,
      Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, Number(v)])) as unknown as CampaignStats
    );
  }
  return result;
}

async function getRow(id: string): Promise<CampaignRow> {
  const { data, error } = await adminClient.from("notification_campaigns").select(COLUMNS).eq("id", id).maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Campaign not found.");
  }
  return data as unknown as CampaignRow;
}

export async function getCampaign(id: string): Promise<CampaignView> {
  const row = await getRow(id);
  const stats = await statsFor([id]);
  return { ...row, stats: stats.get(id) ?? EMPTY_STATS };
}

export async function listCampaigns(query: ListCampaignsQuery): Promise<{ data: CampaignView[]; total: number }> {
  const from = (query.page - 1) * query.pageSize;
  let request = adminClient.from("notification_campaigns").select(COLUMNS, { count: "exact" });
  if (query.status) {
    request = request.eq("status", query.status);
  }
  if (query.kind) {
    request = request.eq("kind", query.kind);
  }
  const { data, error, count } = await request.order("created_at", { ascending: false }).range(from, from + query.pageSize - 1);
  if (error) {
    throw error;
  }
  const rows = (data ?? []) as unknown as CampaignRow[];
  const stats = await statsFor(rows.map((r) => r.id));
  return { data: rows.map((r) => ({ ...r, stats: stats.get(r.id) ?? EMPTY_STATS })), total: count ?? 0 };
}

/** Unknown variables, or listing/offer variables with nothing picked, are refused up front. */
async function checkContent(c: { title: string; body: string; email_subject?: string | null; email_body?: string | null; location_id?: string | null; coupon_id?: string | null }) {
  checkVariables([c.title, c.body, c.email_subject, c.email_body], { listing: Boolean(c.location_id), offer: Boolean(c.coupon_id) });
  if (c.location_id || c.coupon_id) await loadContext(c);
}

export async function createCampaign(actorId: string, input: CreateCampaignInput): Promise<CampaignView> {
  await checkContent(input);
  const { data, error } = await adminClient
    .from("notification_campaigns")
    .insert({
      ...input,
      channels: normalizeChannels(input.channels),
      link_url: input.link_url ?? null,
      email_subject: input.email_subject ?? null,
      email_body: input.email_body ?? null,
      location_id: input.location_id ?? null,
      coupon_id: input.coupon_id ?? null,
      template_id: input.template_id ?? null,
      created_by: actorId,
    })
    .select("id")
    .single();
  if (error) {
    throw error;
  }
  return getCampaign((data as { id: string }).id);
}

export async function updateCampaign(id: string, input: UpdateCampaignInput): Promise<CampaignView> {
  const row = await getRow(id);
  if (row.status !== "draft" && row.status !== "scheduled") {
    throw new ValidationError(`A ${row.status} campaign can no longer be edited.`);
  }
  const next = { ...row, ...input, channels: normalizeChannels(input.channels ?? row.channels) };
  if (next.channels.includes("email") && (!next.email_subject || !next.email_body)) {
    throw new ValidationError("Email needs a subject and a body.");
  }
  await checkContent(next);
  const { error } = await adminClient
    .from("notification_campaigns")
    .update({ ...input, channels: next.channels })
    .eq("id", id);
  if (error) {
    throw error;
  }
  return getCampaign(id);
}

export async function deleteDraftCampaign(id: string): Promise<void> {
  const row = await getRow(id);
  if (row.status !== "draft") {
    throw new ValidationError("Only drafts can be deleted. Cancel a scheduled or sending campaign instead.");
  }
  const { error } = await adminClient.from("notification_campaigns").delete().eq("id", id);
  if (error) {
    throw error;
  }
}

export async function previewAudience(input: AudiencePreviewInput) {
  const { data, error } = await adminClient
    .rpc("admin_audience_preview", { _audience: input.audience, _platforms: input.platforms })
    .single();
  if (error) {
    throw error;
  }
  const row = data as Record<string, number | string>;
  return {
    users: Number(row.users),
    with_email: Number(row.with_email),
    devices: { ios: Number(row.ios_devices), android: Number(row.android_devices), web: Number(row.web_devices) },
  };
}

/** Which channels can actually deliver right now. */
export async function channelReadiness(): Promise<{ email: boolean; push: { ios: boolean; android: boolean; web: boolean } }> {
  const channels = await listChannels();
  const live = (name: string) => channels.some((c) => c.channel === name && c.connected && c.enabled);
  return { email: live("smtp"), push: { ios: live("apns"), android: live("fcm"), web: live("webpush") } };
}

async function assertSendable(row: CampaignRow): Promise<void> {
  await checkContent(row);
  const ready = await channelReadiness();
  if (row.channels.includes("email") && !ready.email) {
    throw new ValidationError("Email is not connected. Connect SMTP under Messaging -> Email, or untick Email.");
  }
  if (row.channels.includes("push") && !row.platforms.some((p) => ready.push[p])) {
    throw new ValidationError(
      `No push provider is connected for ${row.platforms.join(", ")}. Connect one under Messaging -> Push, or untick Push.`
    );
  }
}

/**
 * Send now, or schedule. Returns the campaign after an inline first batch, so a small direct
 * message is usually fully delivered by the time the admin sees the response.
 */
export async function sendCampaign(actorId: string, id: string, scheduledAt?: string): Promise<CampaignView> {
  const row = await getRow(id);
  if (row.status !== "draft" && row.status !== "scheduled") {
    throw new ValidationError(`This campaign is already ${row.status}.`);
  }
  await assertSendable(row);

  if (scheduledAt && new Date(scheduledAt).getTime() > Date.now() + 60_000) {
    const { error } = await adminClient
      .from("notification_campaigns")
      .update({ status: "scheduled", scheduled_at: scheduledAt, sent_by: actorId })
      .eq("id", id);
    if (error) {
      throw error;
    }
    await writeAuditLog(actorId, "ADMIN_SENT_CAMPAIGN", "campaign", id, null, { scheduled_at: scheduledAt, name: row.name });
    return getCampaign(id);
  }

  await startCampaign(id, actorId);
  await writeAuditLog(actorId, "ADMIN_SENT_CAMPAIGN", "campaign", id, null, {
    name: row.name,
    channels: row.channels,
    audience: row.audience.type,
  });
  await processCampaign(id, Date.now() + 8_000);
  return getCampaign(id);
}

async function startCampaign(id: string, actorId: string | null): Promise<void> {
  const { data: claimed, error } = await adminClient
    .from("notification_campaigns")
    .update({ status: "sending", started_at: new Date().toISOString(), ...(actorId ? { sent_by: actorId } : {}) })
    .eq("id", id)
    .in("status", ["draft", "scheduled"])
    .select("id");
  if (error) {
    throw error;
  }
  if (!claimed || claimed.length === 0) {
    return; // someone else (a concurrent dispatcher) started it
  }
  const { error: expandError } = await adminClient.rpc("campaign_expand_recipients", { _campaign_id: id });
  if (expandError) {
    await adminClient.from("notification_campaigns").update({ status: "failed", last_error: expandError.message.slice(0, 500) }).eq("id", id);
    throw expandError;
  }
}

export async function cancelCampaign(actorId: string, id: string): Promise<CampaignView> {
  const row = await getRow(id);
  if (!["draft", "scheduled", "sending"].includes(row.status)) {
    throw new ValidationError(`A ${row.status} campaign cannot be cancelled.`);
  }
  const now = new Date().toISOString();
  const { error } = await adminClient
    .from("notification_campaigns")
    .update({ status: "cancelled", completed_at: now })
    .eq("id", id);
  if (error) {
    throw error;
  }
  // Everyone not yet reached is marked as skipped -- the campaign's numbers then say exactly how
  // far it got before it was stopped.
  for (const column of ["in_app_status", "push_status", "email_status"] as const) {
    const { error: skipError } = await adminClient
      .from("campaign_recipients")
      .update({ [column]: "skipped" })
      .eq("campaign_id", id)
      .is("processed_at", null)
      .eq(column, "pending");
    if (skipError) {
      throw skipError;
    }
  }
  await adminClient.from("campaign_recipients").update({ processed_at: now }).eq("campaign_id", id).is("processed_at", null);
  await writeAuditLog(actorId, "ADMIN_CANCELLED_CAMPAIGN", "campaign", id, null, { name: row.name, previous_status: row.status });
  return getCampaign(id);
}

// ---------------------------------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------------------------------

interface RecipientRow {
  campaign_id: string;
  user_id: string;
  email: string | null;
  in_app_status: string;
  push_status: string;
  email_status: string;
  notification_id: string | null;
}

export function apiBaseUrl(): string {
  const explicit = process.env.PUBLIC_API_BASE_URL;
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  return vercel ? `https://${vercel}` : `http://localhost:${process.env.PORT ?? 4000}`;
}

async function isSuppressed(email: string): Promise<boolean> {
  const { data, error } = await adminClient.from("email_suppressions").select("email").eq("email", email.toLowerCase()).maybeSingle();
  if (error) {
    throw error;
  }
  return Boolean(data);
}

async function processRecipient(campaign: CampaignRow, r: RecipientRow, content: RenderableContent) {
  const rendered = campaign.channels.includes("email") && content.email_body ? renderEmailBody(content.email_body) : null;
  const update: Record<string, unknown> = {};
  const errors: string[] = [];
  let notification: NotificationDetail | null = null;

  if (r.in_app_status === "pending" || r.push_status === "pending") {
    try {
      notification = await createAnnouncementNotification({
        userId: r.user_id,
        campaignId: campaign.id,
        title: content.title,
        body: content.body,
        linkUrl: content.link_url,
      });
      update.notification_id = notification.id;
      if (r.in_app_status === "pending") {
        update.in_app_status = "created";
      }
    } catch (error) {
      update.in_app_status = "failed";
      errors.push(`in-app: ${error instanceof Error ? error.message : "failed"}`);
    }
  }

  if (r.push_status === "pending") {
    if (!notification) {
      update.push_status = "failed";
    } else {
      try {
        const result = await deliverPush(notification, { platforms: campaign.platforms });
        update.push_sent = result.sent;
        update.push_failed = result.failed;
        if (result.outcome !== "delivered") {
          update.push_status = result.outcome;
        } else if (result.sent > 0) {
          update.push_status = result.failed > 0 ? "partial" : "sent";
        } else {
          update.push_status = "failed";
          if (result.failed === 0) {
            errors.push("push: no connected provider for this person's devices");
          }
        }
      } catch (error) {
        update.push_status = "failed";
        errors.push(`push: ${error instanceof Error ? error.message : "failed"}`);
      }
    }
  }

  if (r.email_status === "pending") {
    if (!r.email) {
      update.email_status = "no_email";
    } else if (campaign.kind === "announcement" && (await isSuppressed(r.email))) {
      update.email_status = "unsubscribed";
    } else if (rendered) {
      try {
        const unsubscribeUrl =
          campaign.kind === "announcement"
            ? `${apiBaseUrl()}/v1/email/unsubscribe?token=${encodeURIComponent(await unsubscribeToken(r.email))}`
            : null;
        const email = wrapEmail({
          subject: content.email_subject!,
          bodyHtml: rendered.html,
          bodyText: rendered.text,
          ctaUrl: content.link_url,
          unsubscribeUrl,
        });
        await sendEmail({
          to: r.email,
          subject: content.email_subject!,
          html: email.html,
          text: email.text,
          headers: unsubscribeUrl
            ? { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
            : undefined,
          stream: campaign.kind === "announcement" ? "marketing" : "transactional",
        });
        update.email_status = "sent";
      } catch (error) {
        update.email_status = "failed";
        errors.push(`email: ${error instanceof Error ? error.message : "failed"}`);
      }
    }
  }

  const { error } = await adminClient
    .from("campaign_recipients")
    .update({
      ...update,
      error: errors.length > 0 ? errors.join("; ").slice(0, 1000) : null,
      processed_at: new Date().toISOString(),
    })
    .eq("campaign_id", r.campaign_id)
    .eq("user_id", r.user_id);
  if (error) {
    throw error;
  }
}

/**
 * Work through a sending campaign until `deadline` (epoch ms) or until nobody is left. Email is
 * throttled to the SMTP channel's max_per_minute per call -- the dispatcher runs every minute, so
 * that is also the sustained rate.
 */
export async function processCampaign(id: string, deadline: number): Promise<{ processed: number; done: boolean }> {
  const campaign = await getRow(id);
  if (campaign.status !== "sending") {
    return { processed: 0, done: campaign.status === "sent" };
  }
  const sendsEmail = campaign.channels.includes("email") && Boolean(campaign.email_body);
  let context: CampaignContext;
  try {
    context = await loadContext(campaign);
  } catch (error) {
    // The listing or offer it's about was deleted: stop rather than send half-filled text.
    await adminClient
      .from("notification_campaigns")
      .update({ status: "failed", last_error: error instanceof Error ? error.message.slice(0, 500) : "Context missing." })
      .eq("id", id);
    throw error;
  }
  let emailBudget = Infinity;
  if (sendsEmail) {
    const smtp = (await listChannels()).find((c) => c.channel === "smtp");
    emailBudget = Number((smtp?.config as { max_per_minute?: number } | undefined)?.max_per_minute ?? 60);
  }

  let processed = 0;
  while (Date.now() < deadline) {
    const batchSize = Math.max(1, Math.min(25, emailBudget - processed));
    if (sendsEmail && processed >= emailBudget) {
      break;
    }
    const { data, error } = await adminClient.rpc("campaign_claim_recipients", { _campaign_id: id, _limit: batchSize });
    if (error) {
      throw error;
    }
    const batch = (data ?? []) as RecipientRow[];
    if (batch.length === 0) {
      break;
    }
    const people = await personVars(batch.map((r) => r.user_id));
    for (const recipient of batch) {
      try {
        await processRecipient(campaign, recipient, renderFor(campaign, context, people.get(recipient.user_id)));
      } catch (err) {
        console.error(`Campaign ${id}: recipient ${recipient.user_id} failed:`, err);
        await adminClient
          .from("campaign_recipients")
          .update({ processed_at: new Date().toISOString(), error: err instanceof Error ? err.message.slice(0, 500) : "failed" })
          .eq("campaign_id", id)
          .eq("user_id", recipient.user_id);
      }
      processed += 1;
    }
  }

  const { count, error: remainingError } = await adminClient
    .from("campaign_recipients")
    .select("user_id", { count: "exact", head: true })
    .eq("campaign_id", id)
    .is("processed_at", null);
  if (remainingError) {
    throw remainingError;
  }
  const done = (count ?? 0) === 0;
  if (done) {
    await adminClient
      .from("notification_campaigns")
      .update({ status: "sent", completed_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "sending");
  }
  return { processed, done };
}

/** The job dispatcher's whole job: start due scheduled campaigns, then work on sending ones. */
export async function runCampaignDispatch(deadline: number): Promise<{ started: number; processed: number; campaigns: number }> {
  const now = new Date().toISOString();
  const { data: due, error } = await adminClient
    .from("notification_campaigns")
    .select("id")
    .eq("status", "scheduled")
    .lte("scheduled_at", now);
  if (error) {
    throw error;
  }
  let started = 0;
  for (const { id } of (due ?? []) as { id: string }[]) {
    try {
      const row = await getRow(id);
      await assertSendable(row);
      await startCampaign(id, null);
      started += 1;
    } catch (err) {
      await adminClient
        .from("notification_campaigns")
        .update({ status: "failed", last_error: err instanceof Error ? err.message.slice(0, 500) : "Could not start." })
        .eq("id", id);
    }
  }

  const { data: sending, error: sendingError } = await adminClient
    .from("notification_campaigns")
    .select("id")
    .eq("status", "sending")
    .order("started_at", { ascending: true });
  if (sendingError) {
    throw sendingError;
  }
  let processed = 0;
  const ids = ((sending ?? []) as { id: string }[]).map((r) => r.id);
  for (const id of ids) {
    if (Date.now() >= deadline) {
      break;
    }
    processed += (await processCampaign(id, deadline)).processed;
  }
  return { started, processed, campaigns: ids.length };
}

export async function listCampaignRecipients(id: string, query: CampaignRecipientsQuery) {
  await getRow(id);
  const from = (query.page - 1) * query.pageSize;
  let request = adminClient
    .from("campaign_recipients")
    .select("user_id, email, in_app_status, push_status, email_status, push_sent, push_failed, error, processed_at", {
      count: "exact",
    })
    .eq("campaign_id", id);
  if (query.filter === "pending") {
    request = request.is("processed_at", null);
  } else if (query.filter === "failed") {
    request = request.or("push_status.eq.failed,email_status.eq.failed,in_app_status.eq.failed");
  }
  const { data, error, count } = await request.order("created_at").range(from, from + query.pageSize - 1);
  if (error) {
    throw error;
  }
  const rows = (data ?? []) as { user_id: string }[];
  const { data: profiles } = await adminClient
    .from("profiles")
    .select("id, first_name, last_name")
    .in("id", rows.map((r) => r.user_id));
  const names = new Map(((profiles ?? []) as { id: string; first_name: string | null; last_name: string | null }[]).map((p) => [p.id, p]));
  return {
    data: rows.map((r) => ({ ...r, first_name: names.get(r.user_id)?.first_name ?? null, last_name: names.get(r.user_id)?.last_name ?? null })),
    total: count ?? 0,
  };
}

/**
 * "Send test to me": the exact content, to the signed-in admin only -- their own email and their
 * own devices. Nothing is recorded as a campaign recipient.
 */
export async function sendTestToSelf(actorId: string, actorEmail: string | null, raw: TestCampaignInput) {
  await checkContent(raw);
  const context = await loadContext(raw);
  const me = (await personVars([actorId])).get(actorId);
  const content = renderFor(
    { title: raw.title, body: raw.body, link_url: raw.link_url ?? null, email_subject: raw.email_subject ?? null, email_body: raw.email_body ?? null },
    context,
    me
  );
  const input = { ...raw, ...content };
  const result: { push?: { outcome: string; sent: number; failed: number }; email?: { ok: boolean; detail: string } } = {};
  if (input.channels.includes("push") || input.channels.includes("in_app")) {
    const notification = await createAnnouncementNotification({
      userId: actorId,
      // A fresh id per test: the idempotency key must not collapse two tests into one row.
      campaignId: crypto.randomUUID(),
      title: `[Test] ${input.title}`,
      body: input.body,
      linkUrl: input.link_url ?? null,
    });
    if (input.channels.includes("push")) {
      result.push = await deliverPush(notification, { platforms: input.platforms });
    }
  }
  if (input.channels.includes("email")) {
    if (!actorEmail) {
      result.email = { ok: false, detail: "Your admin account has no email address." };
    } else {
      try {
        const rendered = renderEmailBody(input.email_body!);
        const email = wrapEmail({ subject: input.email_subject!, bodyHtml: rendered.html, bodyText: rendered.text, ctaUrl: input.link_url });
        await sendEmail({ to: actorEmail, subject: `[Test] ${input.email_subject}`, html: email.html, text: email.text });
        result.email = { ok: true, detail: `Sent to ${actorEmail}.` };
      } catch (error) {
        result.email = { ok: false, detail: error instanceof Error ? error.message.slice(0, 300) : "Failed." };
      }
    }
  }
  return result;
}

/**
 * The text as one person would get it: the signed-in admin by default, or someone chosen. Also
 * says which of that person's details were missing (so a fallback was used).
 */
export async function renderPreview(actorId: string, input: RenderPreviewInput) {
  checkVariables([input.title, input.body, input.email_subject, input.email_body], { listing: Boolean(input.location_id), offer: Boolean(input.coupon_id) });
  const context = await loadContext(input);
  const userId = input.user_id ?? actorId;
  const person = (await personVars([userId])).get(userId) ?? {};
  const content = renderFor(
    { title: input.title, body: input.body, link_url: input.link_url ?? null, email_subject: input.email_subject ?? null, email_body: input.email_body ?? null },
    context,
    person
  );
  const used = new Set([input.title, input.body, input.email_subject ?? "", input.email_body ?? ""].join(" ").match(/\{([a-z_]+)/g)?.map((m) => m.slice(1)) ?? []);
  const missing = VARIABLES.filter((v) => v.scope === "person" && used.has(v.key) && !person[v.key]).map((v) => v.key);
  return { ...content, user_id: userId, missing };
}

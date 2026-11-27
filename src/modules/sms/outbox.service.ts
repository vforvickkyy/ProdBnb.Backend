import { NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { SAMPLE_VARS, SMS_FOR_EMAIL, smsVarsFor, SmsVars } from "./content";
import { OutgoingSms, PROVIDERS, SmsProviderId } from "./providers";
import { providerCredentials, recordProviderTest, reportUrl, smsSettings, SmsSettingsRow } from "./settings.service";
import { isIndianNumber, maskPhone, normalizePhone, renderSms, smsSegments } from "./text";

/**
 * The SMS outbox (migration 20261127100000_sms.sql), the same shape as the email outbox.
 *
 * `queueSms` writes one row per event and person (same key twice = no-op) and tries to send it
 * straight away; a failure leaves it queued with a back-off and the job dispatcher retries it.
 * Nothing here ever throws into the booking or payment that caused the text.
 *
 * Modes (Messaging -> SMS in the admin):
 *  - off:  nothing is queued or sent; sign-in codes are refused.
 *  - test: every text is written to the log and NOT sent -- except to the "test numbers", which
 *          get real texts when a provider is connected. Sign-in codes show in the log so the team
 *          can sign in before DLT is approved.
 *  - live: sent through the active provider.
 */

const UNIQUE_VIOLATION = "23505";
const MAX_ATTEMPTS = 6;
const BACKOFF_MINUTES = [1, 5, 15, 60, 180];
const COLUMNS =
  "id, user_id, to_phone, template, idempotency_key, data, body, segments, status, mode, provider, provider_message_id, attempts, last_error, send_after, sent_at, delivered_at, created_at, updated_at";

export type SmsStatus = "queued" | "sending" | "sent" | "delivered" | "failed" | "skipped";

export interface SmsRow {
  id: string;
  user_id: string | null;
  to_phone: string;
  template: string;
  idempotency_key: string;
  data: Record<string, unknown>;
  body: string | null;
  segments: number | null;
  status: SmsStatus;
  mode: "test" | "live";
  provider: string | null;
  provider_message_id: string | null;
  attempts: number;
  last_error: string | null;
  send_after: string;
  sent_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SmsTemplateRow {
  key: string;
  name: string;
  audience: "booker" | "host" | "everyone";
  category: "otp" | "transactional" | "service";
  body: string;
  dlt_template_id: string | null;
  provider_template_id: string | null;
  enabled: boolean;
  sort_order: number;
  updated_at: string;
}

async function template(key: string): Promise<SmsTemplateRow | null> {
  const { data, error } = await adminClient
    .from("sms_templates")
    .select("key, name, audience, category, body, dlt_template_id, provider_template_id, enabled, sort_order, updated_at")
    .eq("key", key)
    .maybeSingle();
  if (error) throw error;
  return (data as SmsTemplateRow | null) ?? null;
}

/** The person's mobile: the number they verified at sign-in, else the one on their profile. */
export async function phoneOf(userId: string): Promise<{ phone: string | null; smsUpdates: boolean }> {
  const [{ data: profile }, { data: auth }] = await Promise.all([
    adminClient.from("profiles").select("phone, sms_updates").eq("id", userId).maybeSingle(),
    adminClient.auth.admin.getUserById(userId),
  ]);
  const verified = normalizePhone(auth?.user?.phone ? `+${auth.user.phone.replace(/^\+/, "")}` : null);
  return {
    phone: verified ?? normalizePhone((profile?.phone as string | null) ?? null),
    smsUpdates: (profile?.sms_updates as boolean | undefined) ?? true,
  };
}

// -- Sending --------------------------------------------------------------------------------------

/**
 * Sends one text now, as the settings say. Returns the provider and message id, or provider "test"
 * when it was only logged.
 */
async function transmit(
  settings: SmsSettingsRow,
  tpl: Pick<SmsTemplateRow, "dlt_template_id" | "provider_template_id" | "category">,
  to: string,
  body: string
): Promise<{ provider: string; messageId: string | null; mode: "test" | "live" }> {
  if (settings.mode === "off") throw new Error("SMS is switched off (Messaging -> SMS in the admin).");
  const realInTest = settings.mode === "test" && settings.test_numbers.includes(to) && settings.active_provider;
  if (settings.mode === "test" && !realInTest) return { provider: "test", messageId: null, mode: "test" };
  const provider = settings.active_provider as SmsProviderId | null;
  if (!provider) throw new Error("No SMS provider chosen yet (Messaging -> SMS in the admin).");
  const creds = await providerCredentials(provider);
  if (!creds) throw new Error(`${PROVIDERS[provider].name} isn't connected any more.`);
  const msg: OutgoingSms = {
    to,
    body,
    senderId: settings.sender_id,
    dltEntityId: settings.dlt_entity_id,
    dltTemplateId: tpl.dlt_template_id,
    providerTemplateId: tpl.provider_template_id,
    category: tpl.category,
    reportUrl: settings.webhook_token ? reportUrl(provider, settings.webhook_token) : null,
  };
  const messageId = await PROVIDERS[provider].send(msg, creds.config, creds.secret);
  return { provider, messageId: messageId || null, mode: settings.mode === "live" ? "live" : "test" };
}

export interface QueueSmsInput {
  userId: string;
  template: string;
  /** One text per key, ever. */
  key: string;
  data: Record<string, unknown>;
}

/** Queues a text and tries to send it now. Never throws. */
export async function queueSms(input: QueueSmsInput): Promise<void> {
  try {
    const settings = await smsSettings();
    if (settings.mode === "off") return;
    const tpl = await template(input.template);
    if (!tpl || !tpl.enabled) return;
    const { phone, smsUpdates } = await phoneOf(input.userId);
    let skip: string | null = null;
    if (!phone) skip = "No mobile number on this account.";
    else if (!isIndianNumber(phone)) skip = "Only Indian mobile numbers get texts.";
    else if (tpl.category === "service" && !smsUpdates) skip = "This person switched off optional texts.";
    const { data, error } = await adminClient
      .from("sms_outbox")
      .insert({
        user_id: input.userId,
        to_phone: phone ?? "(none)",
        template: input.template,
        idempotency_key: input.key,
        data: input.data,
        status: skip ? "skipped" : "queued",
        mode: settings.mode === "live" ? "live" : "test",
        last_error: skip,
      })
      .select(COLUMNS)
      .single();
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return;
      throw error;
    }
    if (!skip) await deliver(data as SmsRow);
  } catch (error) {
    console.error(`SMS ${input.template} (${input.key}) not queued:`, error);
  }
}

/** Called for every transactional email: the matching text goes out too. Never throws. */
export async function queueSmsForEmail(input: { userId: string; template: string; key: string; data: Record<string, unknown> }): Promise<void> {
  const sms = SMS_FOR_EMAIL[input.template];
  if (!sms) return;
  await queueSms({ userId: input.userId, template: sms, key: `${input.key}:sms`, data: input.data });
}

async function deliver(row: SmsRow): Promise<SmsStatus> {
  const { data: claimed } = await adminClient
    .from("sms_outbox")
    .update({ status: "sending", locked_until: new Date(Date.now() + 2 * 60_000).toISOString() })
    .eq("id", row.id)
    .eq("status", "queued")
    .select("id")
    .maybeSingle();
  if (!claimed) return row.status;

  const attempts = row.attempts + 1;
  try {
    const [settings, tpl] = await Promise.all([smsSettings(), template(row.template)]);
    const vars = tpl?.enabled ? await smsVarsFor(row.template, row.data) : null;
    if (!tpl || !tpl.enabled || !vars || settings.mode === "off") {
      const reason = !tpl || !tpl.enabled ? "This text is switched off." : settings.mode === "off" ? "SMS is switched off." : null;
      await adminClient.from("sms_outbox").update({ status: "skipped", attempts, locked_until: null, last_error: reason }).eq("id", row.id);
      return "skipped";
    }
    const body = renderSms(tpl.body, vars);
    const result = await transmit(settings, tpl, row.to_phone, body);
    await adminClient
      .from("sms_outbox")
      .update({
        status: "sent",
        body,
        segments: smsSegments(body).segments,
        mode: result.mode,
        provider: result.provider,
        provider_message_id: result.messageId,
        attempts,
        sent_at: new Date().toISOString(),
        last_error: null,
        locked_until: null,
      })
      .eq("id", row.id);
    return "sent";
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const giveUp = attempts >= MAX_ATTEMPTS;
    const wait = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)]!;
    await adminClient
      .from("sms_outbox")
      .update({
        status: giveUp ? "failed" : "queued",
        attempts,
        last_error: message,
        locked_until: null,
        send_after: new Date(Date.now() + wait * 60_000).toISOString(),
      })
      .eq("id", row.id);
    return giveUp ? "failed" : "queued";
  }
}

/** For the background job dispatcher: sends what is due, until `deadline`. */
export async function processSmsOutbox(deadline: number): Promise<{ sent: number; failed: number; skipped: number; retrying: number }> {
  const summary = { sent: 0, failed: 0, skipped: 0, retrying: 0 };
  await adminClient.from("sms_outbox").update({ status: "queued", locked_until: null }).eq("status", "sending").lt("locked_until", new Date().toISOString());
  while (Date.now() < deadline) {
    const { data, error } = await adminClient
      .from("sms_outbox")
      .select(COLUMNS)
      .eq("status", "queued")
      .lte("send_after", new Date().toISOString())
      .order("send_after", { ascending: true })
      .limit(10);
    if (error) throw error;
    const rows = (data ?? []) as SmsRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      if (Date.now() >= deadline) break;
      const outcome = await deliver(row);
      if (outcome === "sent") summary.sent++;
      else if (outcome === "failed") summary.failed++;
      else if (outcome === "skipped") summary.skipped++;
      else summary.retrying++;
    }
    if (summary.retrying > 0 && rows.every((r) => r.attempts > 0)) break;
  }
  return summary;
}

// -- Sign-in codes --------------------------------------------------------------------------------

export class SmsCodeError extends Error {
  constructor(message: string, readonly httpStatus: number) {
    super(message);
  }
}

/**
 * Sends a sign-in / verification code at once (called by the Supabase "Send SMS" hook). Never
 * retried: the person simply asks again. The log keeps the code only in test mode when nothing was
 * really sent (so the team can sign in before DLT); otherwise it is masked.
 */
export async function sendAuthCode(input: { phone: string; code: string; userId: string | null; hookId: string }): Promise<void> {
  const settings = await smsSettings();
  if (settings.mode === "off") throw new SmsCodeError("Sign-in by SMS is switched off right now.", 503);
  const to = normalizePhone(input.phone);
  if (!to) throw new SmsCodeError("That isn't a mobile number we can text.", 400);
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await adminClient
    .from("sms_outbox")
    .select("id", { count: "exact", head: true })
    .eq("to_phone", to)
    .eq("template", "auth_otp")
    .gte("created_at", since);
  if ((count ?? 0) >= settings.otp_per_hour) {
    throw new SmsCodeError("Too many codes for this number. Wait an hour and try again.", 429);
  }
  const tpl = (await template("auth_otp")) ?? {
    key: "auth_otp",
    body: "{code} is your {brand} code. It expires in 10 minutes. Never share it with anyone.",
    dlt_template_id: null,
    provider_template_id: null,
    category: "otp" as const,
    enabled: true,
  };
  const body = renderSms(tpl.body, { code: input.code });
  let status: "sent" | "failed" = "sent";
  let result: Awaited<ReturnType<typeof transmit>> | null = null;
  let error: string | null = null;
  try {
    result = await transmit(settings, tpl, to, body);
  } catch (e) {
    status = "failed";
    error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
  }
  const loggedOnly = result?.provider === "test";
  await adminClient.from("sms_outbox").insert({
    user_id: input.userId,
    to_phone: to,
    template: "auth_otp",
    idempotency_key: `auth:${input.hookId}`,
    data: {},
    body: loggedOnly ? body : body.replace(input.code, "•".repeat(input.code.length)),
    segments: smsSegments(body).segments,
    status,
    mode: result?.mode ?? (settings.mode === "live" ? "live" : "test"),
    provider: result?.provider ?? settings.active_provider,
    provider_message_id: result?.messageId ?? null,
    attempts: 1,
    last_error: error,
    sent_at: status === "sent" ? new Date().toISOString() : null,
  }).then(({ error: logError }) => {
    if (logError && logError.code !== UNIQUE_VIOLATION) console.error("Sign-in SMS not logged:", logError);
  });
  if (status === "failed") throw new SmsCodeError(`The code couldn't be sent: ${error}`, 500);
}

// -- Delivery reports -----------------------------------------------------------------------------

export async function applyDeliveryReports(provider: SmsProviderId, reports: { messageId: string; status: "delivered" | "failed"; error?: string }[]): Promise<number> {
  let updated = 0;
  for (const r of reports) {
    const patch =
      r.status === "delivered"
        ? { status: "delivered", delivered_at: new Date().toISOString(), last_error: null }
        : { status: "failed", last_error: (r.error ?? "Not delivered").slice(0, 500) };
    const { data } = await adminClient
      .from("sms_outbox")
      .update(patch)
      .eq("provider", provider)
      .eq("provider_message_id", r.messageId)
      .in("status", ["sent", "delivered", "failed"])
      .select("id");
    updated += data?.length ?? 0;
  }
  return updated;
}

// -- Admin ----------------------------------------------------------------------------------------

export async function listTemplates(): Promise<SmsTemplateRow[]> {
  const { data, error } = await adminClient
    .from("sms_templates")
    .select("key, name, audience, category, body, dlt_template_id, provider_template_id, enabled, sort_order, updated_at")
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return (data ?? []) as SmsTemplateRow[];
}

export async function updateTemplate(
  actorId: string,
  key: string,
  input: { body?: string; dlt_template_id?: string | null; provider_template_id?: string | null; enabled?: boolean }
): Promise<SmsTemplateRow> {
  const current = await template(key);
  if (!current) throw new NotFoundError("Text not found.");
  if (input.body !== undefined) {
    const unknown = [...input.body.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]!).filter((n) => !(n in SAMPLE_VARS) && n !== "brand" && n !== "site");
    if (unknown.length) throw new ValidationError(`Unknown placeholder: {${unknown[0]}}. Use the ones listed under the box.`);
    if (key === "auth_otp" && !input.body.includes("{code}")) throw new ValidationError("The sign-in text must include {code}.");
  }
  if (key === "auth_otp" && input.enabled === false) throw new ValidationError("The sign-in code text can't be switched off.");
  const patch: Record<string, unknown> = { updated_by: actorId };
  if (input.body !== undefined) patch.body = input.body;
  if (input.dlt_template_id !== undefined) patch.dlt_template_id = input.dlt_template_id || null;
  if (input.provider_template_id !== undefined) patch.provider_template_id = input.provider_template_id || null;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  const { error } = await adminClient.from("sms_templates").update(patch).eq("key", key);
  if (error) throw error;
  return (await template(key))!;
}

export function previewTemplate(body: string, vars: SmsVars = SAMPLE_VARS): { text: string; encoding: string; characters: number; segments: number } {
  const text = renderSms(body, vars);
  return { text, ...smsSegments(text) };
}

/**
 * Admin "Send test SMS": one text to one number, with example values. In test mode the number must
 * be one of the test numbers to really go out; otherwise it is only logged.
 */
export async function sendTestSms(actorId: string, input: { phone: string; template: string }): Promise<SmsRow> {
  const to = normalizePhone(input.phone);
  if (!to) throw new ValidationError("Enter a mobile number, e.g. +91 98765 43210.");
  const tpl = await template(input.template);
  if (!tpl) throw new NotFoundError("Text not found.");
  const settings = await smsSettings();
  const body = renderSms(tpl.body, SAMPLE_VARS);
  let status: "sent" | "failed" = "sent";
  let result: Awaited<ReturnType<typeof transmit>> | null = null;
  let error: string | null = null;
  try {
    result = await transmit(settings.mode === "off" ? { ...settings, mode: "test" } : settings, tpl, to, body);
  } catch (e) {
    status = "failed";
    error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
  }
  if (result && result.provider !== "test") await recordProviderTest(result.provider as SmsProviderId, true, null);
  else if (!result && settings.active_provider) await recordProviderTest(settings.active_provider, false, error);
  const { data, error: insertError } = await adminClient
    .from("sms_outbox")
    .insert({
      user_id: actorId,
      to_phone: to,
      template: tpl.key,
      idempotency_key: `test:${crypto.randomUUID()}`,
      data: { test: true },
      body,
      segments: smsSegments(body).segments,
      status,
      mode: result?.mode ?? "test",
      provider: result?.provider ?? settings.active_provider,
      provider_message_id: result?.messageId ?? null,
      attempts: 1,
      last_error: error,
      sent_at: status === "sent" ? new Date().toISOString() : null,
    })
    .select(COLUMNS)
    .single();
  if (insertError) throw insertError;
  return data as SmsRow;
}

export interface AdminSmsQuery {
  status?: SmsStatus;
  template?: string;
  search?: string;
  page: number;
  pageSize: number;
}

export async function listSms(query: AdminSmsQuery): Promise<{ data: (SmsRow & { to_phone_masked: string })[]; total: number }> {
  const from = (query.page - 1) * query.pageSize;
  let q = adminClient.from("sms_outbox").select(COLUMNS, { count: "exact" }).order("created_at", { ascending: false }).range(from, from + query.pageSize - 1);
  if (query.status) q = q.eq("status", query.status);
  if (query.template) q = q.eq("template", query.template);
  if (query.search) {
    const digits = query.search.replace(/[^0-9]/g, "");
    if (digits.length >= 4) q = q.ilike("to_phone", `%${digits}%`);
    else {
      const term = query.search.replace(/[,()*%\\]/g, " ").trim();
      if (term) q = q.ilike("body", `%${term}%`);
    }
  }
  const { data, error, count } = await q;
  if (error) throw error;
  return {
    data: ((data ?? []) as SmsRow[]).map((r) => ({ ...r, to_phone_masked: r.to_phone.startsWith("+") ? maskPhone(r.to_phone) : r.to_phone })),
    total: count ?? 0,
  };
}

export async function smsSummary(): Promise<Record<SmsStatus, number> & { test: number }> {
  const statuses: SmsStatus[] = ["queued", "sending", "sent", "delivered", "failed", "skipped"];
  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const counts = await Promise.all(
    statuses.map(async (status) => {
      const { count } = await adminClient.from("sms_outbox").select("id", { count: "exact", head: true }).eq("status", status).gte("created_at", since);
      return [status, count ?? 0] as const;
    })
  );
  const { count: test } = await adminClient.from("sms_outbox").select("id", { count: "exact", head: true }).eq("mode", "test").gte("created_at", since);
  return { ...(Object.fromEntries(counts) as Record<SmsStatus, number>), test: test ?? 0 };
}

/** Sends a failed or skipped text again (never a sign-in code: those are one-time). */
export async function resendSms(id: string): Promise<SmsRow> {
  const { data: row, error } = await adminClient.from("sms_outbox").select(COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!row) throw new NotFoundError("Text not found.");
  const r = row as SmsRow;
  if (r.template === "auth_otp" || r.idempotency_key.startsWith("test:")) throw new ValidationError("Sign-in codes and test texts can't be sent again.");
  if (r.status === "sending") throw new ValidationError("This text is being sent right now.");
  if (!r.to_phone.startsWith("+")) throw new ValidationError("This person has no mobile number.");
  await adminClient.from("sms_outbox").update({ status: "queued", attempts: 0, last_error: null, send_after: new Date().toISOString() }).eq("id", id);
  await deliver({ ...r, status: "queued", attempts: 0 });
  const { data: after } = await adminClient.from("sms_outbox").select(COLUMNS).eq("id", id).single();
  return after as SmsRow;
}

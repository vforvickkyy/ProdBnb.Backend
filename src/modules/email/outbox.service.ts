import { NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { smtpCredentials } from "../outreach/channels.service";
import { sendEmail } from "../outreach/email";
import { emailOf } from "./context";
import { buildEmail, EMAIL_TEMPLATES, EmailTemplate } from "./templates";

/**
 * The email outbox (migration 20261125100000_email_outbox.sql).
 *
 * `queueEmail` writes one row per event and person -- the same `key` twice is a no-op -- and then
 * tries to send it straight away. A failure (email not connected yet, a provider hiccup) leaves
 * the row queued with a back-off; the background job dispatcher retries it. Nothing here ever
 * throws into the booking or payment that caused the email.
 */

const UNIQUE_VIOLATION = "23505";
const MAX_ATTEMPTS = 6;
/** Minutes to wait after each failed attempt. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 180];
const COLUMNS =
  "id, user_id, to_email, template, stream, idempotency_key, data, subject, status, attempts, last_error, provider_message_id, send_after, sent_at, created_at, updated_at";

export interface OutboxRow {
  id: string;
  user_id: string | null;
  to_email: string;
  template: EmailTemplate;
  stream: "transactional" | "marketing";
  idempotency_key: string;
  data: Record<string, unknown>;
  subject: string | null;
  status: "queued" | "sending" | "sent" | "failed" | "skipped";
  attempts: number;
  last_error: string | null;
  provider_message_id: string | null;
  send_after: string;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

let sender: typeof sendEmail = sendEmail;
/** Tests only: capture emails instead of sending them. */
export function setEmailSenderForTesting(fn: typeof sendEmail | null): void {
  sender = fn ?? sendEmail;
}

export interface QueueEmailInput {
  userId: string;
  template: EmailTemplate;
  /** One email per key, ever. Usually `<event key>:<template>`. */
  key: string;
  data: Record<string, unknown>;
}

/** Queues an email and tries to send it now. Never throws. */
export async function queueEmail(input: QueueEmailInput): Promise<void> {
  try {
    const to = await emailOf(input.userId);
    if (!to) return; // no email address on the account (phone-only sign-in)
    const { data, error } = await adminClient
      .from("email_outbox")
      .insert({ user_id: input.userId, to_email: to, template: input.template, idempotency_key: input.key, data: input.data })
      .select(COLUMNS)
      .single();
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return; // already queued for this event
      throw error;
    }
    await deliver(data as OutboxRow);
  } catch (error) {
    console.error(`Email ${input.template} (${input.key}) not queued:`, error);
  }
}

/** Claims a queued row (so two workers never send the same email) and sends it. */
async function deliver(row: OutboxRow): Promise<OutboxRow["status"]> {
  const { data: claimed } = await adminClient
    .from("email_outbox")
    .update({ status: "sending", locked_until: new Date(Date.now() + 2 * 60_000).toISOString() })
    .eq("id", row.id)
    .eq("status", "queued")
    .select("id")
    .maybeSingle();
  if (!claimed) return row.status;

  const attempts = row.attempts + 1;
  try {
    if (sender === sendEmail && !(await smtpCredentials().catch(() => null))) {
      throw new Error("Email isn't connected yet (Messaging → Email in the admin).");
    }
    const built = await buildEmail(row.template, row.data, row.user_id ?? "");
    if (!built) {
      await adminClient.from("email_outbox").update({ status: "skipped", attempts, locked_until: null, last_error: null }).eq("id", row.id);
      return "skipped";
    }
    const messageId = await sender({ to: row.to_email, subject: built.subject, html: built.html, text: built.text, attachments: built.attachments });
    await adminClient
      .from("email_outbox")
      .update({ status: "sent", subject: built.subject, attempts, sent_at: new Date().toISOString(), provider_message_id: messageId, last_error: null, locked_until: null })
      .eq("id", row.id);
    return "sent";
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const giveUp = attempts >= MAX_ATTEMPTS;
    const wait = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)]!;
    await adminClient
      .from("email_outbox")
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
export async function processEmailOutbox(deadline: number): Promise<{ sent: number; failed: number; skipped: number; retrying: number }> {
  const summary = { sent: 0, failed: 0, skipped: 0, retrying: 0 };
  // Rows stuck in "sending" (a worker that died mid-send) go back in the queue.
  await adminClient
    .from("email_outbox")
    .update({ status: "queued", locked_until: null })
    .eq("status", "sending")
    .lt("locked_until", new Date().toISOString());
  while (Date.now() < deadline) {
    const { data, error } = await adminClient
      .from("email_outbox")
      .select(COLUMNS)
      .eq("status", "queued")
      .lte("send_after", new Date().toISOString())
      .order("send_after", { ascending: true })
      .limit(10);
    if (error) throw error;
    const rows = (data ?? []) as OutboxRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      if (Date.now() >= deadline) break;
      const outcome = await deliver(row);
      if (outcome === "sent") summary.sent++;
      else if (outcome === "failed") summary.failed++;
      else if (outcome === "skipped") summary.skipped++;
      else summary.retrying++;
    }
    if (summary.retrying > 0 && rows.every((r) => r.attempts > 0)) break; // only retries left, try next run
  }
  return summary;
}

// -- Admin -------------------------------------------------------------------------------------

export interface AdminEmailQuery {
  status?: OutboxRow["status"];
  template?: EmailTemplate;
  search?: string;
  page: number;
  pageSize: number;
}

export async function listEmails(query: AdminEmailQuery): Promise<{ data: OutboxRow[]; total: number }> {
  const from = (query.page - 1) * query.pageSize;
  let q = adminClient.from("email_outbox").select(COLUMNS, { count: "exact" }).order("created_at", { ascending: false }).range(from, from + query.pageSize - 1);
  if (query.status) q = q.eq("status", query.status);
  if (query.template) q = q.eq("template", query.template);
  if (query.search) {
    const term = query.search.replace(/[,()*%\\]/g, " ").trim();
    if (term) q = q.or(`to_email.ilike.%${term}%,subject.ilike.%${term}%`);
  }
  const { data, error, count } = await q;
  if (error) throw error;
  return { data: (data ?? []) as OutboxRow[], total: count ?? 0 };
}

export async function emailSummary(): Promise<Record<OutboxRow["status"], number>> {
  const statuses: OutboxRow["status"][] = ["queued", "sending", "sent", "failed", "skipped"];
  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const counts = await Promise.all(
    statuses.map(async (status) => {
      const { count } = await adminClient.from("email_outbox").select("id", { count: "exact", head: true }).eq("status", status).gte("created_at", since);
      return [status, count ?? 0] as const;
    })
  );
  return Object.fromEntries(counts) as Record<OutboxRow["status"], number>;
}

/** Sends an email again (a failed one, or a copy of a sent one). */
export async function resendEmail(id: string): Promise<OutboxRow> {
  const { data: row, error } = await adminClient.from("email_outbox").select(COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!row) throw new NotFoundError("Email not found.");
  const r = row as OutboxRow;
  if (r.status === "sending") throw new ValidationError("This email is being sent right now.");
  await adminClient.from("email_outbox").update({ status: "queued", attempts: 0, last_error: null, send_after: new Date().toISOString() }).eq("id", id);
  await deliver({ ...r, status: "queued", attempts: 0 });
  const { data: after } = await adminClient.from("email_outbox").select(COLUMNS).eq("id", id).single();
  return after as OutboxRow;
}

export function isEmailTemplate(value: string): value is EmailTemplate {
  return (EMAIL_TEMPLATES as readonly string[]).includes(value);
}

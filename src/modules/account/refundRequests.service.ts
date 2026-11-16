import { ConflictError, NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { writeAuditLog } from "../admin/audit.service";
import { notifyRefundRequestUpdate } from "../notifications/notification.service";
import { createRefund } from "../payments/payment.service";
import { AdminRefundRequestsQuery, ApproveRefundRequestInput } from "./account.schema";

/**
 * Refund requests (booker account). Money only ever moves on an admin's decision: a request is
 * opened automatically when a paid booking is cancelled or declined, or by the booker when
 * something went wrong; an admin approves it (full or partial, through the existing refund path,
 * so Cashfree and the ledger behave exactly as for any admin refund) or declines it with a note.
 */

export type RefundRequestSource = "booker" | "cancellation" | "rejection";
export type RefundRequestStatus = "pending" | "approved" | "declined" | "withdrawn";

export interface RefundRequest {
  id: string;
  booking_id: string;
  payment_id: string;
  source: RefundRequestSource;
  reason: string | null;
  status: RefundRequestStatus;
  approved_amount_minor_units: number | null;
  refund_id: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  "id, booking_id, payment_id, source, reason, status, approved_amount_minor_units, refund_id, decided_at, decision_note, created_at, updated_at";

/** Settled payments: money was taken and some of it may still be refundable. */
const REFUNDABLE_PAYMENT_STATUSES = ["success", "partially_refunded"] as const;

export interface RefundablePayment {
  id: string;
  amount_minor_units: number;
  currency: string;
  status: string;
  /** Refunds already issued or in flight. */
  committed_minor_units: number;
  remaining_minor_units: number;
}

async function refundablePaymentFor(bookingId: string): Promise<RefundablePayment | null> {
  const { data: payments, error } = await adminClient
    .from("payments")
    .select("id, amount_minor_units, currency, status, created_at")
    .eq("booking_id", bookingId)
    .in("status", [...REFUNDABLE_PAYMENT_STATUSES])
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const payment = payments?.[0];
  if (!payment) return null;
  const committed = await committedRefunds(payment.id);
  const remaining = payment.amount_minor_units - committed;
  return { ...payment, committed_minor_units: committed, remaining_minor_units: remaining };
}

async function committedRefunds(paymentId: string): Promise<number> {
  const { data, error } = await adminClient
    .from("payment_refunds")
    .select("amount_minor_units")
    .eq("payment_id", paymentId)
    .in("status", ["pending", "success"]);
  if (error) throw error;
  return (data ?? []).reduce((sum, r) => sum + (r.amount_minor_units as number), 0);
}

async function pendingFor(paymentId: string): Promise<RefundRequest | null> {
  const { data, error } = await adminClient.from("refund_requests").select(COLUMNS).eq("payment_id", paymentId).eq("status", "pending").maybeSingle();
  if (error) throw error;
  return (data as RefundRequest | null) ?? null;
}

async function insertRequest(row: {
  booking_id: string;
  payment_id: string;
  requested_by: string | null;
  source: RefundRequestSource;
  reason: string | null;
}): Promise<RefundRequest> {
  const { data, error } = await adminClient.from("refund_requests").insert(row).select(COLUMNS).single();
  if (error?.code === "23505") {
    const existing = await pendingFor(row.payment_id);
    if (existing) return existing;
  }
  if (error) throw error;
  return data as RefundRequest;
}

/**
 * Called after a booking is cancelled or declined. Opens a request when money was taken and some
 * of it is still refundable; otherwise does nothing. Never throws: the cancellation already
 * happened and must not be reported as failed because of bookkeeping.
 */
export async function openRefundRequestAfterCancellation(params: {
  bookingId: string;
  bookerId: string;
  source: "cancellation" | "rejection";
  reason: string | null;
  cancelledBy: string | null;
}): Promise<RefundRequest | null> {
  try {
    const payment = await refundablePaymentFor(params.bookingId);
    if (!payment || payment.remaining_minor_units <= 0) return null;
    const existing = await pendingFor(payment.id);
    if (existing) return existing;
    const request = await insertRequest({
      booking_id: params.bookingId,
      payment_id: payment.id,
      requested_by: params.cancelledBy === params.bookerId ? params.bookerId : null,
      source: params.source,
      reason: params.reason,
    });
    await notifyRefundRequestUpdate(params.bookerId, params.bookingId, request.id, "opened");
    return request;
  } catch (err) {
    console.error(`Could not open a refund request for booking ${params.bookingId}:`, err);
    return null;
  }
}

async function loadOwnBooking(userId: string, bookingId: string): Promise<{ id: string; booker_id: string; status: string }> {
  const { data, error } = await adminClient.from("bookings").select("id, booker_id, status").eq("id", bookingId).maybeSingle();
  if (error) throw error;
  // Same answer for "doesn't exist" and "not yours": a booker can't probe other people's bookings.
  if (!data || data.booker_id !== userId) throw new NotFoundError("Booking not found.");
  return data as { id: string; booker_id: string; status: string };
}

/** The booker asks for money back ("something went wrong"). */
export async function createBookerRefundRequest(userId: string, bookingId: string, reason: string): Promise<RefundRequest> {
  const booking = await loadOwnBooking(userId, bookingId);
  if (booking.status === "requested") {
    throw new ValidationError("This booking is still waiting for the host. Cancel it instead; a refund request opens automatically.");
  }
  const payment = await refundablePaymentFor(bookingId);
  if (!payment) throw new ValidationError("There is no payment on this booking to refund.");
  if (payment.remaining_minor_units <= 0) throw new ValidationError("This payment has already been refunded in full.");
  if (await pendingFor(payment.id)) throw new ConflictError("A refund request for this booking is already being reviewed.");
  const request = await insertRequest({ booking_id: bookingId, payment_id: payment.id, requested_by: userId, source: "booker", reason });
  await notifyRefundRequestUpdate(userId, bookingId, request.id, "opened");
  return request;
}

export async function listMyRefundRequests(userId: string, bookingId?: string): Promise<RefundRequest[]> {
  let query = adminClient
    .from("refund_requests")
    .select(`${COLUMNS}, bookings!inner(booker_id)`)
    .eq("bookings.booker_id", userId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (bookingId) query = query.eq("booking_id", bookingId);
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as (RefundRequest & { bookings?: unknown })[]).map(({ bookings: _b, ...rest }) => rest);
}

/** The booker changes their mind. Only while the team hasn't decided. */
export async function withdrawRefundRequest(userId: string, requestId: string): Promise<RefundRequest> {
  const { data, error } = await adminClient.from("refund_requests").select(`${COLUMNS}, bookings!inner(booker_id)`).eq("id", requestId).maybeSingle();
  if (error) throw error;
  const row = data as (RefundRequest & { bookings: { booker_id: string } }) | null;
  if (!row || row.bookings.booker_id !== userId) throw new NotFoundError("Refund request not found.");
  if (row.status !== "pending") throw new ValidationError("This refund request has already been decided.");
  const { data: updated, error: updateError } = await adminClient
    .from("refund_requests")
    .update({ status: "withdrawn" })
    .eq("id", requestId)
    .eq("status", "pending")
    .is("decided_at", null)
    .select(COLUMNS)
    .maybeSingle();
  if (updateError) throw updateError;
  if (!updated) throw new ConflictError("This refund request is being decided right now.");
  return updated as RefundRequest;
}

// Admin -----------------------------------------------------------------------------------------

export interface AdminRefundRequest extends RefundRequest {
  booking: {
    id: string;
    status: string;
    start_at: string;
    end_at: string;
    cancellation_reason: string | null;
    location: { id: string; title: string; city: string | null } | null;
    booker: { id: string; first_name: string | null; last_name: string | null } | null;
  } | null;
  payment: { id: string; amount_minor_units: number; currency: string; status: string; method: string | null } | null;
  refunded_minor_units: number;
  remaining_minor_units: number;
}

export async function listAdminRefundRequests(query: AdminRefundRequestsQuery): Promise<{ data: AdminRefundRequest[]; total: number }> {
  const from = (query.page - 1) * query.pageSize;
  let q = adminClient
    .from("refund_requests")
    .select(
      `${COLUMNS},
       booking:bookings!inner(id, status, start_at, end_at, cancellation_reason,
         location:locations(id, title, city),
         booker:profiles!booker_id(id, first_name, last_name)),
       payment:payments(id, amount_minor_units, currency, status, method)`,
      { count: "exact" }
    )
    .order("created_at", { ascending: query.status === "pending" })
    .range(from, from + query.pageSize - 1);
  if (query.status) q = q.eq("status", query.status);
  const { data, error, count } = await q;
  if (error) throw error;
  const rows = (data ?? []) as unknown as Omit<AdminRefundRequest, "refunded_minor_units" | "remaining_minor_units">[];
  const enriched = await Promise.all(
    rows.map(async (row) => {
      const committed = row.payment ? await committedRefunds(row.payment.id) : 0;
      return {
        ...row,
        refunded_minor_units: committed,
        remaining_minor_units: row.payment ? Math.max(0, row.payment.amount_minor_units - committed) : 0,
      };
    })
  );
  return { data: enriched, total: count ?? enriched.length };
}

async function claim(requestId: string, adminId: string): Promise<RefundRequest & { bookings: { booker_id: string } }> {
  // Claiming first (decided_at set while still pending) stops two admins acting on one request at
  // once, and stops the booker withdrawing it mid-decision.
  const { data, error } = await adminClient
    .from("refund_requests")
    .update({ decided_by: adminId, decided_at: new Date().toISOString() })
    .eq("id", requestId)
    .eq("status", "pending")
    .is("decided_at", null)
    .select(`${COLUMNS}, bookings!inner(booker_id)`)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const { data: exists } = await adminClient.from("refund_requests").select("id, status").eq("id", requestId).maybeSingle();
    if (!exists) throw new NotFoundError("Refund request not found.");
    throw new ConflictError(exists.status === "pending" ? "Another admin is deciding this request." : "This refund request has already been decided.");
  }
  return data as unknown as RefundRequest & { bookings: { booker_id: string } };
}

async function release(requestId: string): Promise<void> {
  await adminClient.from("refund_requests").update({ decided_by: null, decided_at: null }).eq("id", requestId).eq("status", "pending");
}

export async function approveRefundRequest(adminId: string, requestId: string, input: ApproveRefundRequestInput): Promise<RefundRequest> {
  const request = await claim(requestId, adminId);
  let refund;
  try {
    refund = await createRefund(true, request.payment_id, {
      amount_minor_units: input.amount_minor_units,
      reason: input.note ?? request.reason ?? undefined,
    });
  } catch (err) {
    await release(requestId);
    throw err;
  }
  const { data, error } = await adminClient
    .from("refund_requests")
    .update({
      status: "approved",
      refund_id: refund.id,
      approved_amount_minor_units: refund.amount_minor_units,
      decision_note: input.note ?? null,
    })
    .eq("id", requestId)
    .select(COLUMNS)
    .single();
  if (error) throw error;
  await writeAuditLog(adminId, "ADMIN_CREATED_REFUND", "payment", request.payment_id, input.note ?? null, {
    refund_id: refund.id,
    amount_minor_units: refund.amount_minor_units,
    refund_request_id: requestId,
  });
  await writeAuditLog(adminId, "ADMIN_APPROVED_REFUND_REQUEST", "refund_request", requestId, input.note ?? null, {
    booking_id: request.booking_id,
    payment_id: request.payment_id,
    refund_id: refund.id,
    amount_minor_units: refund.amount_minor_units,
  });
  await notifyRefundRequestUpdate(request.bookings.booker_id, request.booking_id, requestId, "approved");
  return data as RefundRequest;
}

export async function declineRefundRequest(adminId: string, requestId: string, note: string): Promise<RefundRequest> {
  const request = await claim(requestId, adminId);
  const { data, error } = await adminClient
    .from("refund_requests")
    .update({ status: "declined", decision_note: note })
    .eq("id", requestId)
    .select(COLUMNS)
    .single();
  if (error) {
    await release(requestId);
    throw error;
  }
  await writeAuditLog(adminId, "ADMIN_DECLINED_REFUND_REQUEST", "refund_request", requestId, note, {
    booking_id: request.booking_id,
    payment_id: request.payment_id,
  });
  await notifyRefundRequestUpdate(request.bookings.booker_id, request.booking_id, requestId, "declined");
  return data as RefundRequest;
}

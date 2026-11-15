import { SupabaseClient } from "@supabase/supabase-js";
import { NotFoundError } from "../../errors/AppError";
import { PaymentDetail, RefundDetail } from "../payments/payment.service";
import { AdminListPaymentsQuery, AdminListRefundsQuery } from "./admin.schema";

// Both `payments` and `payment_refunds` already have a has_role(admin)
// branch on their SELECT RLS policy (Phase 7) -- these listings use the
// caller's own request-scoped client, no adminClient needed for reads.

interface NameRef {
  first_name: string | null;
  last_name: string | null;
}

export interface BookingContext {
  id: string;
  location_id: string;
  booker_id: string;
  location: { title: string } | null;
  booker: NameRef | null;
}

// Admin-only extensions -- deliberately NOT merged into the shared
// PaymentDetail/RefundDetail interfaces those types share with the regular,
// booker-facing /v1/payments/* routes (payment.service.ts uses its own,
// narrower PAYMENT_COLUMNS/REFUND_COLUMNS for those). Widening the shared
// type would misdescribe what a non-admin caller's response actually
// contains; these extend it instead (Phase 14).
export interface AdminPaymentDetail extends PaymentDetail {
  booking: BookingContext | null;
}

export interface AdminRefundDetail extends RefundDetail {
  payment: { id: string; booking: BookingContext | null } | null;
}

// Booker identity joined the same way as bookings.service.ts's
// BOOKING_DETAIL_SELECT: `booker:profiles!booker_id` disambiguates against
// bookings' second FK to profiles (cancelled_by). Name only, never email --
// profiles has no email column by design (Phase 1); an admin who needs it
// drills into the User detail page instead, which is the one place an
// Admin Auth API lookup per-user is appropriate, not here across a list.
const PAYMENT_COLUMNS = `
  id, booking_id, provider, provider_order_id, provider_reference_id,
  status, amount_minor_units, currency, failure_reason, created_at, updated_at,
  booking:bookings ( id, location_id, booker_id, location:locations ( title ), booker:profiles!booker_id ( first_name, last_name ) )
`;

const REFUND_COLUMNS = `
  id, payment_id, provider_refund_id, provider_reference_id,
  status, amount_minor_units, reason, created_at, updated_at,
  payment:payments ( id, booking:bookings ( id, location_id, booker_id, location:locations ( title ), booker:profiles!booker_id ( first_name, last_name ) ) )
`;

export interface PaginatedPayments {
  data: AdminPaymentDetail[];
  total: number;
}

export interface PaginatedRefunds {
  data: AdminRefundDetail[];
  total: number;
}

export async function listAllPayments(supabase: SupabaseClient, query: AdminListPaymentsQuery): Promise<PaginatedPayments> {
  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  let request = supabase.from("payments").select(PAYMENT_COLUMNS, { count: "exact" });
  if (query.status) {
    request = request.eq("status", query.status);
  }
  if (query.provider) {
    request = request.eq("provider", query.provider);
  }
  if (query.booking_id) {
    request = request.eq("booking_id", query.booking_id);
  }
  if (query.created_after) {
    request = request.gte("created_at", query.created_after);
  }
  if (query.created_before) {
    request = request.lte("created_at", query.created_before);
  }

  const { data, error, count } = await request.order("created_at", { ascending: false }).range(from, to);
  if (error) {
    throw error;
  }
  return { data: (data ?? []) as unknown as AdminPaymentDetail[], total: count ?? 0 };
}

/**
 * Admin payment detail with the same booking/location/booker join as the
 * list -- deliberately NOT the regular, booker-facing getPayment() from
 * payment.service.ts, which uses a narrower select with no such join (Phase
 * 14: an admin detail view and a booker's own payment view are answering
 * different questions, so they stay two functions, not one widened one).
 */
export async function getAdminPayment(supabase: SupabaseClient, paymentId: string): Promise<AdminPaymentDetail> {
  const { data, error } = await supabase.from("payments").select(PAYMENT_COLUMNS).eq("id", paymentId).maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Payment not found.");
  }
  return data as unknown as AdminPaymentDetail;
}

export async function listAllRefunds(supabase: SupabaseClient, query: AdminListRefundsQuery): Promise<PaginatedRefunds> {
  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  let request = supabase.from("payment_refunds").select(REFUND_COLUMNS, { count: "exact" });
  if (query.status) {
    request = request.eq("status", query.status);
  }
  if (query.payment_id) {
    request = request.eq("payment_id", query.payment_id);
  }

  const { data, error, count } = await request.order("created_at", { ascending: false }).range(from, to);
  if (error) {
    throw error;
  }
  return { data: (data ?? []) as unknown as AdminRefundDetail[], total: count ?? 0 };
}

// -- Admin Console: payments needing attention ------------------------------------------------

export interface PaymentNeedingAttention extends AdminPaymentDetail {
  /** Why it needs a human: what happened to the booking after money was taken. */
  booking_status: string;
  hold_expired: boolean;
  cancelled_at: string | null;
  refunded_minor_units: number;
}

/**
 * Money taken for a booking that is no longer going ahead -- `cancelled` (by a person, or by
 * unpaid-hold expiry when a delayed payment settled after the hold lapsed) or `rejected` -- and not
 * yet fully refunded. Payment success deliberately never changes booking status and cancellation
 * deliberately never auto-refunds (Phase 7: no refund *policy* engine exists), so every one of
 * these is a decision an admin has to make. The Admin Console surfaces them as a queue instead of
 * relying on someone noticing.
 */
export async function listPaymentsNeedingAttention(
  supabase: SupabaseClient,
  page: number,
  pageSize: number
): Promise<{ data: PaymentNeedingAttention[]; total: number }> {
  const from = (page - 1) * pageSize;
  const select = PAYMENT_COLUMNS.replace(
    "booking:bookings ( id, location_id, booker_id,",
    "booking:bookings!inner ( id, location_id, booker_id, status, hold_expired_at, cancelled_at,"
  ).replace("updated_at,\n", "updated_at, refunds:payment_refunds ( amount_minor_units, status ),\n");

  const { data, error, count } = await supabase
    .from("payments")
    .select(select, { count: "exact" })
    .in("status", ["success", "partially_refunded"])
    .in("booking.status", ["cancelled", "rejected"])
    .order("created_at", { ascending: false })
    .range(from, from + pageSize - 1);
  if (error) {
    throw error;
  }

  type Row = AdminPaymentDetail & {
    booking: (BookingContext & { status: string; hold_expired_at: string | null; cancelled_at: string | null }) | null;
    refunds: { amount_minor_units: number; status: string }[] | null;
  };
  const rows = ((data ?? []) as unknown as Row[]).map(({ refunds, ...row }) => ({
    ...row,
    booking_status: row.booking?.status ?? "unknown",
    hold_expired: Boolean(row.booking?.hold_expired_at),
    cancelled_at: row.booking?.cancelled_at ?? null,
    refunded_minor_units: (refunds ?? []).filter((r) => r.status === "success").reduce((sum, r) => sum + r.amount_minor_units, 0),
  }));
  return { data: rows, total: count ?? 0 };
}

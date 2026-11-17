import { adminClient } from "../../lib/supabase";
import { EarningState } from "./payouts.schema";

/**
 * What a host earns, per booking.
 *
 * The booker pays the listing price plus the platform fee and tax on top (see platformCharges), so
 * the host's share is the listing price (`base_amount_minor_units`). A refund reduces it in
 * proportion: if 40% of what the booker paid went back, the host's share falls by 40%.
 *
 * When it becomes payable ("ready"): the shoot has happened (or the booker cancelled and money was
 * kept), the payment is settled, and no refund request is waiting for a decision. Bookings the host
 * declined or cancelled earn nothing. Each booking is paid out at most once (host_payout_items).
 */

export interface EarningRow {
  booking_id: string;
  location: { id: string; title: string; city: string | null };
  booking_status: string;
  booking_type: string;
  start_at: string;
  end_at: string;
  currency: string;
  /** The listing price: the host's share before refunds. */
  listing_price_minor_units: number;
  /** The host's own coupon on this booking (comes out of their share); 0 otherwise. */
  host_discount_minor_units: number;
  /** What the booker paid in total (listing price + fee + tax). */
  paid_minor_units: number;
  refunded_minor_units: number;
  /** The host's share now: listing price reduced in proportion to refunds. */
  net_minor_units: number;
  state: EarningState;
  payout: { id: string; paid_at: string; reference: string } | null;
}

export interface EarningsSummary {
  currency: string;
  upcoming_minor_units: number;
  ready_minor_units: number;
  on_hold_minor_units: number;
  paid_minor_units: number;
}

const SETTLED = new Set(["success", "partially_refunded", "refunded"]);

interface RawPayment {
  id: string;
  status: string;
  amount_minor_units: number;
  created_at: string;
  payment_refunds: { amount_minor_units: number; status: string }[] | null;
}

interface RawBooking {
  id: string;
  status: string;
  booking_type: string;
  start_at: string;
  end_at: string;
  base_amount_minor_units: number;
  discount_minor_units: number;
  discount_funded_by: "platform" | "host" | null;
  currency: string;
  cancelled_by: string | null;
  location: { id: string; title: string; city: string | null; host_id: string };
  payments: RawPayment[] | null;
  refund_requests: { status: string }[] | null;
  payout_item:
    | { payout_id: string; amount_minor_units: number; payout: { paid_at: string; reference: string } | null }
    | { payout_id: string; amount_minor_units: number; payout: { paid_at: string; reference: string } | null }[]
    | null;
}

const SELECT = `
  id, status, booking_type, start_at, end_at, base_amount_minor_units, discount_minor_units, discount_funded_by, currency, cancelled_by,
  location:locations!inner(id, title, city, host_id),
  payments(id, status, amount_minor_units, created_at, payment_refunds(amount_minor_units, status)),
  refund_requests(status),
  payout_item:host_payout_items(payout_id, amount_minor_units, payout:host_payouts(paid_at, reference))
`;

export function earningFor(b: RawBooking, now = Date.now()): EarningRow | null {
  const payment = (b.payments ?? []).filter((p) => SETTLED.has(p.status)).sort((x, y) => y.created_at.localeCompare(x.created_at))[0];
  if (!payment) return null;
  const refunded = (payment.payment_refunds ?? []).filter((r) => r.status === "success").reduce((s, r) => s + r.amount_minor_units, 0);
  const paid = payment.amount_minor_units;
  // A host's own coupon comes out of their share; a ProdBnb coupon doesn't.
  const hostDiscount = b.discount_funded_by === "host" ? (b.discount_minor_units ?? 0) : 0;
  const share = Math.max(0, b.base_amount_minor_units - hostDiscount);
  let net = paid > 0 ? Math.max(0, Math.round((share * (paid - refunded)) / paid)) : 0;
  const item = Array.isArray(b.payout_item) ? (b.payout_item[0] ?? null) : b.payout_item;

  let state: EarningState;
  if (item) {
    state = "paid";
    net = item.amount_minor_units;
  } else if (b.status === "rejected" || (b.status === "cancelled" && b.cancelled_by === b.location.host_id)) {
    state = "not_payable";
    net = 0;
  } else if (net <= 0) {
    state = "not_payable";
  } else if ((b.refund_requests ?? []).some((r) => r.status === "pending")) {
    state = "on_hold";
  } else if (b.status === "requested") {
    state = new Date(b.end_at).getTime() > now ? "upcoming" : "not_payable";
  } else if (b.status === "confirmed" && new Date(b.end_at).getTime() > now) {
    state = "upcoming";
  } else {
    state = "ready";
  }

  return {
    booking_id: b.id,
    location: { id: b.location.id, title: b.location.title, city: b.location.city },
    booking_status: b.status,
    booking_type: b.booking_type,
    start_at: b.start_at,
    end_at: b.end_at,
    currency: b.currency,
    listing_price_minor_units: b.base_amount_minor_units,
    host_discount_minor_units: hostDiscount,
    paid_minor_units: paid,
    refunded_minor_units: refunded,
    net_minor_units: net,
    state,
    payout: item?.payout ? { id: item.payout_id, paid_at: item.payout.paid_at, reference: item.payout.reference } : null,
  };
}

export function summarise(rows: EarningRow[]): EarningsSummary {
  const sum = (state: EarningState) => rows.filter((r) => r.state === state).reduce((s, r) => s + r.net_minor_units, 0);
  return {
    currency: rows[0]?.currency ?? "INR",
    upcoming_minor_units: sum("upcoming"),
    ready_minor_units: sum("ready"),
    on_hold_minor_units: sum("on_hold"),
    paid_minor_units: sum("paid"),
  };
}

/** Every paid booking at the host's listings (or at everyone's, for the admin "due" list). */
export async function loadEarnings(hostId?: string): Promise<(EarningRow & { host_id: string })[]> {
  let query = adminClient.from("bookings").select(SELECT).order("start_at", { ascending: false }).limit(5000);
  if (hostId) query = query.eq("location.host_id", hostId);
  const { data, error } = await query;
  if (error) throw error;
  const now = Date.now();
  return ((data ?? []) as unknown as RawBooking[])
    .map((b) => {
      const row = earningFor(b, now);
      return row ? { ...row, host_id: b.location.host_id } : null;
    })
    .filter((r): r is EarningRow & { host_id: string } => r !== null);
}

export async function hostEarnings(hostId: string): Promise<{ summary: EarningsSummary; rows: EarningRow[] }> {
  const rows = (await loadEarnings(hostId)).map(({ host_id: _h, ...row }) => row);
  return { summary: summarise(rows), rows };
}

import { adminClient } from "../../lib/supabase";
import { BookingContext, loadBooking, loadLocation, personOf } from "../email/context";
import { smsMoney, smsWhen } from "./text";

/**
 * The values for each SMS template, loaded fresh when the text is sent (so it always carries the
 * latest booking details). Null = don't send (e.g. the booking changed since the event).
 */

export type SmsVars = Record<string, string | number | null>;
type Data = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Email template -> SMS template: every event that sends an email also sends this text. */
export const SMS_FOR_EMAIL: Record<string, string> = {
  quote_request_sent: "quote_request_sent",
  quote_ready: "quote_ready",
  booking_confirmed: "booking_confirmed",
  booking_declined: "booking_declined",
  booking_cancelled: "booking_cancelled",
  payment_success: "payment_success",
  payment_failed: "payment_failed",
  refund_processed: "refund_processed",
  booking_reminder: "booking_reminder",
  host_booking_request: "host_booking_request",
  host_quote_request: "host_quote_request",
  host_booking_confirmed: "host_booking_confirmed",
  host_booking_cancelled: "host_booking_cancelled",
  host_booking_reminder: "host_booking_reminder",
  payout_sent: "payout_sent",
  listing_approved: "listing_approved",
  listing_rejected: "listing_rejected",
};

function bookingVars(b: BookingContext, forHost: boolean): SmsVars {
  return {
    name: forHost ? b.host.first_name : b.booker.first_name,
    place: b.location.title,
    when: smsWhen(b.start_at, b.end_at, b.location.timezone),
    ref: b.ref,
    crew: b.crew_size ?? "-",
    booker: b.booker.name,
    amount: smsMoney(forHost ? b.base_amount_minor_units : b.total_amount_minor_units, b.currency),
  };
}

export async function smsVarsFor(template: string, data: Data): Promise<SmsVars | null> {
  switch (template) {
    case "quote_request_sent":
    case "booking_declined":
    case "booking_cancelled":
    case "payment_failed":
    case "booking_reminder":
    case "quote_ready":
    case "booking_confirmed":
    case "payment_success": {
      const b = await loadBooking(str(data.bookingId));
      if (!b) return null;
      if (template === "booking_confirmed" && b.status !== "confirmed") return null;
      if (template === "booking_reminder" && b.status !== "confirmed") return null;
      return bookingVars(b, false);
    }
    case "refund_processed": {
      const b = await loadBooking(str(data.bookingId));
      if (!b) return null;
      const vars = bookingVars(b, false);
      const paymentId = str(data.paymentId);
      if (paymentId) {
        const { data: refunds } = await adminClient.from("payment_refunds").select("amount_minor_units, status").eq("payment_id", paymentId);
        const total = ((refunds ?? []) as { amount_minor_units: number; status: string }[])
          .filter((r) => r.status === "success")
          .reduce((s, r) => s + r.amount_minor_units, 0);
        if (total) vars.amount = smsMoney(total, b.currency);
      }
      return vars;
    }
    case "host_booking_request":
    case "host_quote_request":
    case "host_booking_cancelled":
    case "host_booking_reminder": {
      const b = await loadBooking(str(data.bookingId));
      if (!b) return null;
      if (template === "host_booking_reminder" && b.status !== "confirmed") return null;
      return bookingVars(b, true);
    }
    case "host_booking_confirmed": {
      const b = await loadBooking(str(data.bookingId));
      // Only instant bookings: a host who accepted it themselves already knows.
      if (!b || b.status !== "confirmed" || !b.location.instant_booking_enabled) return null;
      return bookingVars(b, true);
    }
    case "payout_sent": {
      const { data: payout } = await adminClient
        .from("host_payouts")
        .select("host_id, amount_minor_units, currency, account_last4")
        .eq("id", str(data.payoutId))
        .maybeSingle();
      if (!payout) return null;
      const host = await personOf(payout.host_id as string);
      return {
        name: host.first_name,
        amount: smsMoney(payout.amount_minor_units as number, (payout.currency as string) ?? "INR"),
        account: (payout.account_last4 as string | null) ?? "-",
      };
    }
    case "listing_approved":
    case "listing_rejected": {
      const loc = await loadLocation(str(data.locationId));
      if (!loc) return null;
      if (template === "listing_approved" && loc.status !== "published") return null;
      const host = await personOf(loc.host_id);
      return { name: host.first_name, place: loc.title || "Your listing" };
    }
    default:
      return null;
  }
}

/** Example values, for previews in the admin and the test send. */
export const SAMPLE_VARS: SmsVars = {
  code: "482913",
  name: "Ananya",
  place: "Sunlit Loft, Bandra West",
  when: "Fri 27 Nov, 8:30 am-6 pm",
  ref: "6A231847",
  crew: 22,
  booker: "Ananya Iyer",
  amount: "Rs.22,000",
  account: "4821",
};

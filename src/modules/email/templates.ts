import { env } from "../../config/env";
import { adminClient } from "../../lib/supabase";
import { emailActionUrl } from "./actions";
import { BookingContext, loadBooking, loadLocation, personOf } from "./context";
import { Block, money, renderLayout, RenderedEmail, siteUrl, whenLabel } from "./layout";

/**
 * Every transactional email, by name. Each one is rendered when it is sent, from ids in `data`,
 * so it shows the booking as it is now -- and returns null ("skip") when the moment has passed
 * (for example a request the host already answered).
 */

export const EMAIL_TEMPLATES = [
  // Booker
  "quote_request_sent",
  "quote_ready",
  "booking_confirmed",
  "booking_declined",
  "booking_cancelled",
  "payment_success",
  "payment_failed",
  "refund_processed",
  "booking_reminder",
  // Host
  "host_booking_request",
  "host_quote_request",
  "host_booking_confirmed",
  "host_booking_cancelled",
  "listing_submitted",
  "listing_approved",
  "listing_rejected",
  "listing_suspended",
  "listing_restored",
  "payout_sent",
  "host_booking_reminder",
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface BuiltEmail extends RenderedEmail {
  attachments?: EmailAttachment[];
}

type Data = Record<string, unknown>;
const brand = () => env.BRAND_NAME;
const str = (v: unknown) => (typeof v === "string" ? v : "");

function place(b: BookingContext, exact: boolean): string {
  const where = exact && b.location.address ? b.location.address : b.location.area || null;
  return [where, b.location.city].filter(Boolean).join(", ") || b.location.title;
}

/** The facts both sides see about a booking. `exact` adds the street address (after confirming). */
function bookingRows(b: BookingContext, opts: { exact?: boolean; forHost?: boolean } = {}): [string, string][] {
  const rows: [string, string][] = [
    ["Place", b.location.title],
    ["When", whenLabel(b.start_at, b.end_at, b.location.timezone)],
    ["Where", place(b, Boolean(opts.exact))],
  ];
  if (b.crew_size) rows.push(["People on set", String(b.crew_size)]);
  if (b.shoot_type) rows.push(["Shoot", b.shoot_type]);
  if (b.production_name || b.project_name) rows.push(["Production", [b.production_name, b.project_name].filter(Boolean).join(" · ")]);
  if (opts.forHost) {
    rows.push(["Booked by", b.booker.name]);
  }
  rows.push(["Booking ref", b.ref]);
  return rows;
}

function amountRows(b: BookingContext): [string, string][] {
  const rows: [string, string][] = [["Price", money(b.base_amount_minor_units, b.currency)]];
  if (b.discount_minor_units) rows.push(["Discount", `− ${money(b.discount_minor_units, b.currency)}`]);
  if (b.platform_fee_minor_units) rows.push(["Service fee", money(b.platform_fee_minor_units, b.currency)]);
  if (b.tax_minor_units) rows.push(["Taxes", money(b.tax_minor_units, b.currency)]);
  rows.push(["Total", money(b.total_amount_minor_units, b.currency)]);
  return rows;
}

const bookerBooking = (b: BookingContext) => siteUrl(`/account/bookings/${b.id}`);
const hostBooking = (b: BookingContext) => siteUrl(`/host/bookings/${b.id}`);
const hostListing = (id: string) => siteUrl(`/host/listings/${id}`);

function page(subject: string, preheader: string, blocks: Block[]): BuiltEmail {
  return renderLayout({ subject, preheader, blocks });
}

async function booking(data: Data): Promise<BookingContext | null> {
  return loadBooking(str(data.bookingId));
}

// ---------------------------------------------------------------------------------------------
// Booker
// ---------------------------------------------------------------------------------------------

async function quoteRequestSent(data: Data): Promise<BuiltEmail | null> {
  const b = await booking(data);
  if (!b) return null;
  return page(`Price request sent: ${b.location.title}`, `The host will send you a price. Nothing to pay yet.`, [
    { kind: "heading", text: "Your price request is with the host" },
    { kind: "text", text: `Hi ${b.booker.first_name}, ${b.host.first_name} will look at your shoot details and send you a price. You'll pay only if you accept it.` },
    { kind: "details", rows: bookingRows(b) },
    { kind: "button", label: "View request", url: bookerBooking(b) },
  ]);
}

async function quoteReady(data: Data): Promise<BuiltEmail | null> {
  const b = await booking(data);
  if (!b || b.status !== "requested") return null;
  return page(`Your price is ready: ${money(b.total_amount_minor_units, b.currency)}`, `Pay to confirm your shoot at ${b.location.title}.`, [
    { kind: "heading", text: "Your price is ready" },
    { kind: "text", text: `Hi ${b.booker.first_name}, ${b.host.first_name} sent a price for your shoot. Pay to confirm it before someone else books these hours.` },
    { kind: "details", rows: [...bookingRows(b), ...amountRows(b)] },
    { kind: "button", label: "Review and pay", url: bookerBooking(b) },
  ]);
}

async function bookingConfirmed(data: Data): Promise<BuiltEmail | null> {
  const b = await booking(data);
  if (!b || b.status !== "confirmed") return null;
  const contact: [string, string][] = [["Host", b.host.name]];
  if (b.host.phone) contact.push(["Host phone", b.host.phone]);
  return page(`Confirmed: ${b.location.title}, ${whenLabel(b.start_at, b.end_at, b.location.timezone)}`, `Your shoot is booked. Address and host contact inside.`, [
    { kind: "heading", text: "Your booking is confirmed" },
    { kind: "text", text: `Hi ${b.booker.first_name}, you're all set. Here's everything for the day.` },
    { kind: "details", rows: [...bookingRows(b, { exact: true }), ...contact] },
    { kind: "button", label: "View booking", url: bookerBooking(b) },
    { kind: "text", muted: true, text: "Need to change something? Message your host from the booking page." },
  ]);
}

async function bookingDeclined(data: Data): Promise<BuiltEmail | null> {
  const b = await booking(data);
  if (!b) return null;
  const blocks: Block[] = [
    { kind: "heading", text: "Your request wasn't accepted" },
    { kind: "text", text: `Hi ${b.booker.first_name}, ${b.host.first_name} can't host this shoot.` },
  ];
  if (b.cancellation_reason) blocks.push({ kind: "note", text: `Host's note: ${b.cancellation_reason}` });
  blocks.push(
    { kind: "details", rows: bookingRows(b) },
    { kind: "text", text: "If you paid, your money is refunded to your original payment method. We'll email you when it's done." },
    { kind: "button", label: "Find another place", url: siteUrl(`/search${b.location.city ? `?city=${encodeURIComponent(b.location.city.split(",")[0]!)}` : ""}`) }
  );
  return page(`Not accepted: ${b.location.title}`, "Find another place for your shoot.", blocks);
}

async function bookingCancelled(data: Data, recipientId: string): Promise<BuiltEmail | null> {
  const b = await booking(data);
  if (!b) return null;
  const byYou = b.cancelled_by === recipientId;
  const blocks: Block[] = [
    { kind: "heading", text: "Booking cancelled" },
    { kind: "text", text: byYou ? `Hi ${b.booker.first_name}, you cancelled this booking.` : `Hi ${b.booker.first_name}, this booking was cancelled.` },
  ];
  if (b.cancellation_reason) blocks.push({ kind: "note", text: `Reason: ${b.cancellation_reason}` });
  blocks.push(
    { kind: "details", rows: bookingRows(b) },
    { kind: "text", text: "Any refund due goes back to your original payment method. We'll email you when it's processed." },
    { kind: "button", label: "View booking", url: bookerBooking(b) }
  );
  return page(`Cancelled: ${b.location.title}`, "Refund details inside.", blocks);
}

async function paymentSuccess(data: Data): Promise<BuiltEmail | null> {
  const b = await booking(data);
  if (!b) return null;
  const confirmed = b.status === "confirmed";
  const email = page(
    confirmed ? `Payment received, you're booked: ${b.location.title}` : `Payment received: ${b.location.title}`,
    confirmed ? "Your booking is confirmed." : "Your request is with the host.",
    [
      { kind: "heading", text: "Payment received" },
      {
        kind: "text",
        text: confirmed
          ? `Hi ${b.booker.first_name}, thanks for your payment. Your booking is confirmed.`
          : `Hi ${b.booker.first_name}, thanks for your payment. Your request is now with ${b.host.first_name}, who'll accept or decline soon. If it's declined, you get a full refund.`,
      },
      { kind: "details", rows: [...bookingRows(b), ...amountRows(b)] },
      { kind: "text", muted: true, text: "Your receipt is attached. Your tax invoice comes in a separate email." },
      { kind: "button", label: "View booking", url: bookerBooking(b) },
    ]
  );
  const paymentId = str(data.paymentId);
  if (paymentId) {
    try {
      const { receiptPdf } = await import("../invoices/invoices.service");
      const receipt = await receiptPdf(paymentId);
      return { ...email, attachments: [{ filename: receipt.filename, content: Buffer.from(receipt.pdf), contentType: "application/pdf" }] };
    } catch (error) {
      console.error(`Receipt for payment ${paymentId} not attached:`, error);
    }
  }
  return email;
}

async function paymentFailed(data: Data): Promise<BuiltEmail | null> {
  const b = await booking(data);
  if (!b) return null;
  return page(`Payment didn't go through: ${b.location.title}`, "Nothing was charged. Try again to keep these hours.", [
    { kind: "heading", text: "Your payment didn't go through" },
    { kind: "text", text: `Hi ${b.booker.first_name}, we couldn't complete your payment. If any money left your account, your bank returns it automatically.` },
    { kind: "details", rows: bookingRows(b) },
    { kind: "button", label: "Try again", url: bookerBooking(b) },
  ]);
}

async function refundProcessed(data: Data): Promise<BuiltEmail | null> {
  const b = await booking(data);
  if (!b) return null;
  let amount = "";
  const paymentId = str(data.paymentId);
  if (paymentId) {
    const { data: refunds } = await adminClient.from("payment_refunds").select("amount_minor_units, status").eq("payment_id", paymentId);
    const total = ((refunds ?? []) as { amount_minor_units: number; status: string }[]).filter((r) => r.status === "success").reduce((s, r) => s + r.amount_minor_units, 0);
    if (total) amount = money(total, b.currency);
  }
  return page(`Refund processed${amount ? `: ${amount}` : ""}`, "It can take 5–7 working days to show in your account.", [
    { kind: "heading", text: "Your refund is on its way" },
    { kind: "text", text: `Hi ${b.booker.first_name}, we've refunded ${amount || "your payment"} to your original payment method. Banks usually take 5–7 working days to show it.` },
    { kind: "details", rows: bookingRows(b) },
    { kind: "button", label: "View booking", url: bookerBooking(b), secondary: true },
  ]);
}

// ---------------------------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------------------------

async function hostBookingRequest(data: Data): Promise<BuiltEmail | null> {
  const b = await booking(data);
  if (!b || b.status !== "requested") return null; // already answered or expired
  const [accept, decline] = await Promise.all([emailActionUrl(b.id, b.location.host_id, "accept"), emailActionUrl(b.id, b.location.host_id, "decline")]);
  const blocks: Block[] = [
    { kind: "heading", text: "New booking request" },
    { kind: "text", text: `Hi ${b.host.first_name}, ${b.booker.name} wants to book ${b.location.title}. They've paid; accept to confirm it.` },
    { kind: "details", rows: [...bookingRows(b, { forHost: true }), ["Your price", money(b.base_amount_minor_units, b.currency)]] },
  ];
  if (b.shoot_notes) blocks.push({ kind: "note", text: `Their notes: ${b.shoot_notes}` });
  blocks.push(
    { kind: "buttons", items: [{ label: "Accept", url: accept }, { label: "Decline", url: decline, secondary: true }] },
    { kind: "text", muted: true, text: "Each button opens a page where you confirm. Please answer soon: unanswered requests expire and the booker is refunded." },
    { kind: "button", label: "Open in your host dashboard", url: hostBooking(b), secondary: true }
  );
  return page(`New request: ${b.location.title}, ${whenLabel(b.start_at, b.end_at, b.location.timezone)}`, `${b.booker.name} wants to book. Accept or decline.`, blocks);
}

async function hostQuoteRequest(data: Data): Promise<BuiltEmail | null> {
  const b = await booking(data);
  if (!b || b.status !== "requested") return null;
  const blocks: Block[] = [
    { kind: "heading", text: "Someone wants a price" },
    { kind: "text", text: `Hi ${b.host.first_name}, ${b.booker.name} wants to shoot at ${b.location.title} and asked for your price.` },
    { kind: "details", rows: bookingRows(b, { forHost: true }) },
  ];
  if (b.shoot_notes) blocks.push({ kind: "note", text: `Their notes: ${b.shoot_notes}` });
  blocks.push({ kind: "button", label: "Send a price", url: hostBooking(b) });
  return page(`Price request: ${b.location.title}`, `${b.booker.name} asked for your price.`, blocks);
}

async function hostBookingConfirmed(data: Data): Promise<BuiltEmail | null> {
  const b = await booking(data);
  // Only for instant bookings: when the host accepted it themselves, they already know.
  if (!b || b.status !== "confirmed" || !b.location.instant_booking_enabled) return null;
  const rows = bookingRows(b, { forHost: true, exact: true });
  if (b.booker.phone) rows.push(["Booker phone", b.booker.phone]);
  return page(`New booking: ${b.location.title}, ${whenLabel(b.start_at, b.end_at, b.location.timezone)}`, `${b.booker.name} booked instantly.`, [
    { kind: "heading", text: "You have a new booking" },
    { kind: "text", text: `Hi ${b.host.first_name}, ${b.booker.name} booked ${b.location.title} with instant booking. It's confirmed.` },
    { kind: "details", rows: [...rows, ["Your price", money(b.base_amount_minor_units, b.currency)]] },
    { kind: "button", label: "View booking", url: hostBooking(b) },
  ]);
}

async function hostBookingCancelled(data: Data, recipientId: string): Promise<BuiltEmail | null> {
  const b = await booking(data);
  if (!b) return null;
  const blocks: Block[] = [
    { kind: "heading", text: "Booking cancelled" },
    { kind: "text", text: b.cancelled_by === recipientId ? `Hi ${b.host.first_name}, you cancelled this booking.` : `Hi ${b.host.first_name}, ${b.booker.name} cancelled this booking. These hours are free again.` },
  ];
  if (b.cancellation_reason) blocks.push({ kind: "note", text: `Reason: ${b.cancellation_reason}` });
  blocks.push({ kind: "details", rows: bookingRows(b, { forHost: true }) }, { kind: "button", label: "View booking", url: hostBooking(b), secondary: true });
  return page(`Cancelled: ${b.location.title}`, "These hours are free again.", blocks);
}

async function listingEmail(template: EmailTemplate, data: Data): Promise<BuiltEmail | null> {
  const loc = await loadLocation(str(data.locationId));
  if (!loc) return null;
  const host = await personOf(loc.host_id);
  const name = loc.title || "Your listing";
  const idLine: [string, string][] = [["Listing", name], ...(loc.listing_code ? ([["Listing ID", loc.listing_code]] as [string, string][]) : [])];
  switch (template) {
    case "listing_submitted":
      return page(`We're reviewing ${name}`, "We'll email you when it's live.", [
        { kind: "heading", text: "Thanks, your listing is in review" },
        { kind: "text", text: `Hi ${host.first_name}, our team checks every listing so bookers can trust what they see. We'll email you as soon as it's approved, or tell you what to change.` },
        { kind: "details", rows: idLine },
        { kind: "button", label: "View listing", url: hostListing(loc.id), secondary: true },
      ]);
    case "listing_approved":
      return page(`${name} is live on ${brand()}`, "Productions can now find and book it.", [
        { kind: "heading", text: "Your listing is live 🎉" },
        { kind: "text", text: `Hi ${host.first_name}, ${name} is approved and visible to productions. Keep your calendar and prices up to date to get more requests.` },
        { kind: "details", rows: idLine },
        { kind: "buttons", items: [{ label: "See it live", url: siteUrl(`/locations/${loc.id}`) }, { label: "Manage listing", url: hostListing(loc.id), secondary: true }] },
      ]);
    case "listing_rejected":
      return page(`Changes needed: ${name}`, "See what to change, then send it again.", [
        { kind: "heading", text: "Your listing needs a few changes" },
        { kind: "text", text: `Hi ${host.first_name}, we couldn't approve ${name} yet.` },
        ...(loc.moderation_reason ? ([{ kind: "note", text: `What to change: ${loc.moderation_reason}` }] as Block[]) : []),
        { kind: "details", rows: idLine },
        { kind: "button", label: "Edit listing", url: hostListing(loc.id) },
        { kind: "text", muted: true, text: "Stuck? Reply to this email or ask for a callback from your listings page." },
      ]);
    case "listing_suspended":
      return page(`${name} is paused`, "It's hidden from bookers for now.", [
        { kind: "heading", text: "Your listing is paused" },
        { kind: "text", text: `Hi ${host.first_name}, our team paused ${name}, so bookers can't see it for now.` },
        ...(loc.moderation_reason ? ([{ kind: "note", text: `Reason: ${loc.moderation_reason}` }] as Block[]) : []),
        { kind: "details", rows: idLine },
        { kind: "text", text: "Reply to this email if you'd like to talk about it." },
      ]);
    case "listing_restored":
      return page(`${name} is live again`, "Bookers can see it again.", [
        { kind: "heading", text: "Your listing is live again" },
        { kind: "text", text: `Hi ${host.first_name}, ${name} is visible to bookers again.` },
        { kind: "details", rows: idLine },
        { kind: "button", label: "Manage listing", url: hostListing(loc.id), secondary: true },
      ]);
    default:
      return null;
  }
}

async function payoutSent(data: Data): Promise<BuiltEmail | null> {
  const { data: payout } = await adminClient
    .from("host_payouts")
    .select("id, host_id, amount_minor_units, currency, reference, paid_at, account_last4")
    .eq("id", str(data.payoutId))
    .maybeSingle();
  if (!payout) return null;
  const host = await personOf(payout.host_id as string);
  const { count } = await adminClient.from("host_payout_items").select("booking_id", { count: "exact", head: true }).eq("payout_id", payout.id as string);
  const amount = money(payout.amount_minor_units as number, (payout.currency as string) ?? "INR");
  const rows: [string, string][] = [
    ["Amount", amount],
    ["Paid on", new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(payout.paid_at as string))],
  ];
  if (payout.account_last4) rows.push(["To account", `•••• ${payout.account_last4}`]);
  if (payout.reference) rows.push(["Bank reference (UTR)", payout.reference as string]);
  if (count) rows.push(["Bookings", String(count)]);
  return page(`Payout sent: ${amount}`, "It should reach your bank within 1–2 working days.", [
    { kind: "heading", text: "We've sent your payout" },
    { kind: "text", text: `Hi ${host.first_name}, your earnings are on their way to your bank account.` },
    { kind: "details", rows },
    { kind: "button", label: "See earnings", url: siteUrl("/host/earnings"), secondary: true },
  ]);
}

/** The day before the shoot: where to go and who to call, for the booker. */
async function bookingReminder(data: Data): Promise<BuiltEmail | null> {
  const b = await booking(data);
  if (!b || b.status !== "confirmed" || new Date(b.start_at).getTime() < Date.now()) return null;
  const contact: [string, string][] = [["Host", b.host.name]];
  if (b.host.phone) contact.push(["Host phone", b.host.phone]);
  return page(`Tomorrow: ${b.location.title}`, `Your shoot is coming up. Address and host contact inside.`, [
    { kind: "heading", text: "Your shoot is tomorrow" },
    { kind: "text", text: `Hi ${b.booker.first_name}, a quick reminder with everything you need for the day.` },
    { kind: "details", rows: [...bookingRows(b, { exact: true }), ...contact] },
    { kind: "button", label: "View booking", url: bookerBooking(b) },
    { kind: "text", muted: true, text: "Running late or need something? Message your host from the booking page." },
  ]);
}

/** The day before the shoot, for the host: who is coming and how many. */
async function hostBookingReminder(data: Data): Promise<BuiltEmail | null> {
  const b = await booking(data);
  if (!b || b.status !== "confirmed" || new Date(b.start_at).getTime() < Date.now()) return null;
  const contact: [string, string][] = [["Booked by", b.booker.name]];
  if (b.booker.phone) contact.push(["Booker phone", b.booker.phone]);
  return page(`Tomorrow: shoot at ${b.location.title}`, `A shoot is coming up at your place.`, [
    { kind: "heading", text: "You have a shoot tomorrow" },
    { kind: "text", text: `Hi ${b.host.first_name}, here are the details so your place is ready.` },
    { kind: "details", rows: [...bookingRows(b, { exact: true, forHost: true }), ...contact] },
    { kind: "button", label: "View booking", url: hostBooking(b) },
  ]);
}

/** Renders a template for its recipient. Null means "don't send" (the moment has passed). */
export async function buildEmail(template: EmailTemplate, data: Data, recipientId: string): Promise<BuiltEmail | null> {
  switch (template) {
    case "quote_request_sent":
      return quoteRequestSent(data);
    case "quote_ready":
      return quoteReady(data);
    case "booking_confirmed":
      return bookingConfirmed(data);
    case "booking_declined":
      return bookingDeclined(data);
    case "booking_cancelled":
      return bookingCancelled(data, recipientId);
    case "payment_success":
      return paymentSuccess(data);
    case "payment_failed":
      return paymentFailed(data);
    case "refund_processed":
      return refundProcessed(data);
    case "host_booking_request":
      return hostBookingRequest(data);
    case "host_quote_request":
      return hostQuoteRequest(data);
    case "host_booking_confirmed":
      return hostBookingConfirmed(data);
    case "host_booking_cancelled":
      return hostBookingCancelled(data, recipientId);
    case "listing_submitted":
    case "listing_approved":
    case "listing_rejected":
    case "listing_suspended":
    case "listing_restored":
      return listingEmail(template, data);
    case "payout_sent":
      return payoutSent(data);
    case "booking_reminder":
      return bookingReminder(data);
    case "host_booking_reminder":
      return hostBookingReminder(data);
  }
}

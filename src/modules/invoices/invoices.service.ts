import { NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { escapeHtml } from "./text";
import { sendEmail } from "../outreach/email";
import { smtpCredentials } from "../outreach/channels.service";
import { amountInWords, renderPdf, type PdfDocInput } from "./pdf";

/**
 * Invoices: one tax invoice per paid booking, for the full amount the booker paid. See the
 * migration (20261118120000_invoices.sql) for the rules.
 */

export interface InvoiceSettings {
  id: string;
  legal_name: string | null;
  trade_name: string | null;
  gstin: string | null;
  pan: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  state_code: string | null;
  postal_code: string | null;
  country: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  number_prefix: string;
  sac_code: string | null;
  tax_label: string;
  notes: string | null;
  terms: string | null;
  signatory: string | null;
  auto_send: boolean;
  updated_at: string;
}

const SETTINGS_COLUMNS = `id, legal_name, trade_name, gstin, pan, address_line1, address_line2, city, state, state_code, postal_code, country,
  email, phone, website, number_prefix, sac_code, tax_label, notes, terms, signatory, auto_send, updated_at`;

export async function getInvoiceSettings(): Promise<InvoiceSettings> {
  const { data, error } = await adminClient.from("invoice_settings").select(SETTINGS_COLUMNS).eq("singleton", true).maybeSingle();
  if (error) throw error;
  if (data) return data as InvoiceSettings;
  const { data: created, error: e2 } = await adminClient.from("invoice_settings").insert({ singleton: true }).select(SETTINGS_COLUMNS).single();
  if (e2) throw e2;
  return created as InvoiceSettings;
}

/** What's still missing before invoices can be issued (company name and address). */
export function missingSettings(s: InvoiceSettings): string[] {
  const missing: string[] = [];
  if (!s.legal_name) missing.push("legal name");
  if (!s.address_line1 || !s.city || !s.state || !s.postal_code) missing.push("address");
  return missing;
}

export async function updateInvoiceSettings(patch: Partial<Omit<InvoiceSettings, "id" | "updated_at">>, adminId: string): Promise<InvoiceSettings> {
  const current = await getInvoiceSettings();
  const { error } = await adminClient.from("invoice_settings").update({ ...patch, updated_by: adminId }).eq("id", current.id);
  if (error) {
    if (error.code === "23514") throw new ValidationError("Some details aren't valid. Check the GSTIN, PAN, state code and SAC code.");
    throw error;
  }
  return getInvoiceSettings();
}

// -- Financial year and numbers --------------------------------------------------------------------

/** Indian financial year (April–March) of an instant, as "26-27". */
export function financialYear(at: Date): string {
  const ist = new Date(at.getTime() + 330 * 60_000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${String(start % 100).padStart(2, "0")}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export function invoiceNumber(prefix: string, fy: string, seq: number): string {
  return `${prefix}/${fy}/${String(seq).padStart(4, "0")}`;
}

// -- Shapes ------------------------------------------------------------------------------------------

export interface Party {
  name: string;
  legal_name?: string | null;
  company?: string | null;
  gstin?: string | null;
  pan?: string | null;
  address: string[];
  state?: string | null;
  state_code?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
}

export interface InvoiceDetails {
  booking_ref: string;
  listing: string;
  city: string | null;
  booking_type: string;
  when: string;
  payment_ref: string | null;
  payment_method: string | null;
  paid_at: string | null;
}

export interface Invoice {
  id: string;
  number: string;
  fy: string;
  booking_id: string;
  payment_id: string | null;
  user_id: string | null;
  issued_at: string;
  seller: Party;
  billed_to: Party;
  details: InvoiceDetails;
  currency: string;
  subtotal_minor_units: number;
  discount_minor_units: number;
  coupon_code: string | null;
  service_fee_minor_units: number;
  tax_minor_units: number;
  tax_rate_bps: number | null;
  total_minor_units: number;
  tax_label: string;
  sac_code: string | null;
  delivery_status: "pending" | "sent" | "failed";
  sent_via: "auto" | "manual" | null;
  sent_at: string | null;
  sent_to: string | null;
  send_count: number;
  last_error: string | null;
}

const INVOICE_COLUMNS = `id, number, fy, booking_id, payment_id, user_id, issued_at, seller, billed_to, details, currency, subtotal_minor_units,
  discount_minor_units, coupon_code, service_fee_minor_units, tax_minor_units, tax_rate_bps, total_minor_units, tax_label, sac_code,
  delivery_status, sent_via, sent_at, sent_to, send_count, last_error`;

const TYPE_LABEL: Record<string, string> = { hourly: "Hourly", half_day: "Half day", day: "Full day", multi_day: "Multiple days" };
const METHOD_LABEL: Record<string, string> = { upi: "UPI", credit_card: "Credit card", debit_card: "Debit card", net_banking: "Net banking", wallet: "Wallet" };

function when(start: string, end: string, tz: string): string {
  const d = (x: string) => new Date(x).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: tz });
  const t = (x: string) => new Date(x).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz });
  return d(start) === d(end) ? `${d(start)}, ${t(start)}–${t(end)}` : `${d(start)} ${t(start)} – ${d(end)} ${t(end)}`;
}

const SETTLED = ["success", "partially_refunded", "refunded"];

/** "Pine forest cottage, Chail", without repeating a city the title already names. */
export function placeLabel(title: string | null | undefined, city: string | null | undefined): string {
  const t = (title ?? "").trim();
  const c = (city ?? "").trim();
  if (!c || t.toLowerCase().includes(c.toLowerCase())) return t || c;
  return t ? `${t}, ${c}` : c;
}

async function emailOf(userId: string): Promise<string | null> {
  const { data } = await adminClient.auth.admin.getUserById(userId);
  return data?.user?.email ?? null;
}

interface PaidBooking {
  payment: { id: string; booking_id: string; status: string; amount_minor_units: number; currency: string; method: string | null; provider_order_id: string | null; updated_at: string; created_at: string };
  booking: {
    id: string;
    booker_id: string;
    booking_type: string;
    start_at: string;
    end_at: string;
    base_amount_minor_units: number;
    platform_fee_minor_units: number;
    tax_minor_units: number;
    discount_minor_units: number;
    total_amount_minor_units: number;
    currency: string;
    coupon: { code: string } | null;
    location: { id: string; title: string; city: string | null; timezone: string } | null;
  };
}

async function loadPaid(paymentId: string): Promise<PaidBooking | null> {
  const { data, error } = await adminClient
    .from("payments")
    .select(
      `id, booking_id, status, amount_minor_units, currency, method, provider_order_id, created_at, updated_at,
       booking:bookings(id, booker_id, booking_type, start_at, end_at, base_amount_minor_units, platform_fee_minor_units, tax_minor_units,
         discount_minor_units, total_amount_minor_units, currency, coupon:coupons(code), location:locations(id, title, city, timezone))`
    )
    .eq("id", paymentId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { booking, ...payment } = data as unknown as PaidBooking["payment"] & { booking: PaidBooking["booking"] | null };
  if (!booking || !SETTLED.includes(payment.status)) return null;
  return { payment, booking };
}

function sellerFrom(s: InvoiceSettings): Party {
  return {
    name: s.trade_name || s.legal_name || "",
    legal_name: s.legal_name,
    gstin: s.gstin,
    pan: s.pan,
    address: [s.address_line1, s.address_line2, [s.city, s.state, s.postal_code].filter(Boolean).join(", "), s.country].filter((x): x is string => Boolean(x)),
    state: s.state,
    state_code: s.state_code,
    email: s.email,
    phone: s.phone,
    website: s.website,
  };
}

async function billedToFor(userId: string): Promise<Party> {
  const [{ data: p }, { data: billing }, email] = await Promise.all([
    adminClient
      .from("profiles")
      .select("first_name, last_name, phone, address_line1, address_line2, address_city, address_region, address_postal_code, address_country")
      .eq("id", userId)
      .maybeSingle(),
    adminClient.from("user_billing_profiles").select("company_name, gst_number").eq("user_id", userId).maybeSingle(),
    emailOf(userId),
  ]);
  const prof = (p ?? {}) as Record<string, string | null>;
  const bill = (billing ?? {}) as { company_name?: string | null; gst_number?: string | null };
  const name = [prof.first_name, prof.last_name].filter(Boolean).join(" ") || email || "Customer";
  return {
    name,
    company: bill.company_name ?? null,
    gstin: bill.gst_number ?? null,
    address: [prof.address_line1, prof.address_line2, [prof.address_city, prof.address_region, prof.address_postal_code].filter(Boolean).join(", "), prof.address_country].filter(
      (x): x is string => Boolean(x)
    ),
    state: prof.address_region ?? null,
    email,
    phone: prof.phone ?? null,
  };
}

/**
 * Issues the invoice for a paid booking (once), then emails it if sending is on and email works.
 * Returns null when the template isn't complete yet: those bookings are listed as waiting and can
 * be issued in one go once it is. Never throws into the payment flow (callers guard it too).
 */
export async function issueInvoiceForPayment(paymentId: string, opts: { send?: boolean } = {}): Promise<Invoice | null> {
  const paid = await loadPaid(paymentId);
  if (!paid) return null;
  const existing = await adminClient.from("invoices").select(INVOICE_COLUMNS).eq("booking_id", paid.booking.id).maybeSingle();
  if (existing.data) return existing.data as Invoice;

  const settings = await getInvoiceSettings();
  if (missingSettings(settings).length) return null;

  const issuedAt = new Date();
  const fy = financialYear(issuedAt);
  const { data: seq, error: seqError } = await adminClient.rpc("next_invoice_number", { _fy: fy });
  if (seqError) throw seqError;
  const b = paid.booking;
  const taxable = b.base_amount_minor_units - b.discount_minor_units + b.platform_fee_minor_units;
  const row = {
    number: invoiceNumber(settings.number_prefix, fy, seq as number),
    fy,
    sequence: seq as number,
    booking_id: b.id,
    payment_id: paid.payment.id,
    user_id: b.booker_id,
    issued_at: issuedAt.toISOString(),
    seller: sellerFrom(settings),
    billed_to: await billedToFor(b.booker_id),
    details: {
      booking_ref: b.id.slice(0, 8).toUpperCase(),
      listing: b.location?.title ?? "Location booking",
      city: b.location?.city ?? null,
      booking_type: TYPE_LABEL[b.booking_type] ?? b.booking_type,
      when: when(b.start_at, b.end_at, b.location?.timezone ?? "Asia/Kolkata"),
      payment_ref: paid.payment.provider_order_id,
      payment_method: paid.payment.method ? (METHOD_LABEL[paid.payment.method] ?? paid.payment.method) : null,
      paid_at: paid.payment.updated_at,
    } satisfies InvoiceDetails,
    currency: b.currency,
    subtotal_minor_units: b.base_amount_minor_units,
    discount_minor_units: b.discount_minor_units,
    coupon_code: b.coupon?.code ?? null,
    service_fee_minor_units: b.platform_fee_minor_units,
    tax_minor_units: b.tax_minor_units,
    tax_rate_bps: taxable > 0 && b.tax_minor_units > 0 ? Math.round((b.tax_minor_units * 10_000) / taxable / 25) * 25 : null,
    total_minor_units: b.total_amount_minor_units,
    tax_label: settings.tax_label,
    sac_code: settings.sac_code,
  };
  const { data: inserted, error } = await adminClient.from("invoices").insert(row).select(INVOICE_COLUMNS).single();
  if (error) {
    // Two settlement paths raced: the other one issued it.
    if (error.code === "23505") return ((await adminClient.from("invoices").select(INVOICE_COLUMNS).eq("booking_id", b.id).single()).data as Invoice) ?? null;
    throw error;
  }
  const invoice = inserted as Invoice;
  await adminClient.from("invoice_events").insert({ invoice_id: invoice.id, kind: "issued" });
  if ((opts.send ?? true) && settings.auto_send) {
    return (await sendInvoice(invoice.id, { via: "auto" }).catch(() => null)) ?? invoice;
  }
  return invoice;
}

// -- PDF ---------------------------------------------------------------------------------------------

function partyLines(p: Party, kind: "seller" | "buyer"): string[] {
  return [
    ...(kind === "seller" && p.legal_name && p.legal_name !== p.name ? [p.legal_name] : []),
    ...(kind === "buyer" && p.company ? [p.company] : []),
    ...p.address,
    ...(p.gstin ? [`GSTIN: ${p.gstin}`] : []),
    ...(kind === "seller" && p.pan ? [`PAN: ${p.pan}`] : []),
    ...(p.state_code ? [`State code: ${p.state_code}`] : []),
    [p.email, p.phone].filter(Boolean).join(" · "),
    ...(p.website ? [p.website] : []),
  ].filter(Boolean);
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

export function invoicePdfInput(inv: Invoice, settings: Pick<InvoiceSettings, "notes" | "terms" | "signatory">): PdfDocInput {
  const intraState = Boolean(inv.seller.state && inv.billed_to.state && inv.seller.state.trim().toLowerCase() === inv.billed_to.state.trim().toLowerCase());
  const rate = inv.tax_rate_bps ? inv.tax_rate_bps / 100 : null;
  const taxable = inv.subtotal_minor_units - inv.discount_minor_units + inv.service_fee_minor_units;
  const taxLines: PdfDocInput["totals"] = [];
  if (inv.tax_minor_units > 0) {
    if (intraState) {
      const cgst = Math.round(inv.tax_minor_units / 2);
      taxLines.push({ label: `CGST${rate ? ` @ ${rate / 2}%` : ""}`, amount: cgst }, { label: `SGST${rate ? ` @ ${rate / 2}%` : ""}`, amount: inv.tax_minor_units - cgst });
    } else {
      taxLines.push({ label: `${inv.tax_label === "GST" ? "IGST" : inv.tax_label}${rate ? ` @ ${rate}%` : ""}`, amount: inv.tax_minor_units });
    }
  }
  return {
    title: "TAX INVOICE",
    number: inv.number,
    date: fmtDate(inv.issued_at),
    seller: { name: inv.seller.name, lines: partyLines(inv.seller, "seller") },
    billedTo: { name: inv.billed_to.name, lines: partyLines(inv.billed_to, "buyer") },
    details: [
      ["Booking", inv.details.booking_ref],
      ["Location", placeLabel(inv.details.listing, inv.details.city)],
      ["When", inv.details.when],
      ["Type", inv.details.booking_type],
      ...(inv.details.paid_at ? ([["Paid", `${fmtDate(inv.details.paid_at)}${inv.details.payment_method ? ` · ${inv.details.payment_method}` : ""}`]] as [string, string][]) : []),
      ...(inv.details.payment_ref ? ([["Payment ref", inv.details.payment_ref]] as [string, string][]) : []),
    ],
    lines: [
      { description: `Location booking: ${inv.details.listing} (${inv.details.booking_type}, ${inv.details.when})`, sac: inv.sac_code, amount: inv.subtotal_minor_units },
      ...(inv.discount_minor_units > 0 ? [{ description: `Discount${inv.coupon_code ? ` (offer ${inv.coupon_code})` : ""}`, amount: inv.discount_minor_units, negative: true }] : []),
      ...(inv.service_fee_minor_units > 0 ? [{ description: "Service fee", sac: inv.sac_code, amount: inv.service_fee_minor_units }] : []),
    ],
    totals: [{ label: "Taxable value", amount: taxable }, ...taxLines, { label: "Total (INR)", amount: inv.total_minor_units, strong: true }],
    amountInWords: amountInWords(inv.total_minor_units),
    notes: settings.notes,
    terms: settings.terms,
    signatory: settings.signatory,
    footer: `${inv.number} · This is a computer-generated invoice.`,
  };
}

export async function invoicePdf(inv: Invoice): Promise<Uint8Array> {
  return renderPdf(invoicePdfInput(inv, await getInvoiceSettings()));
}

/** A made-up invoice with the given template, for the template editor's preview. */
export async function previewPdf(settings: InvoiceSettings): Promise<Uint8Array> {
  const now = new Date().toISOString();
  const sample: Invoice = {
    id: "preview",
    number: invoiceNumber(settings.number_prefix, financialYear(new Date()), 1),
    fy: financialYear(new Date()),
    booking_id: "preview",
    payment_id: null,
    user_id: null,
    issued_at: now,
    seller: sellerFrom(settings),
    billed_to: { name: "Aditi Sharma", company: "Lantern Films Pvt Ltd", gstin: "27AABCL1234F1Z5", address: ["4th Floor, Kamala Mills", "Lower Parel, Mumbai, Maharashtra 400013", "India"], state: "Maharashtra", email: "aditi@example.com", phone: "+91 98765 43210" },
    details: { booking_ref: "3F2A9C1B", listing: "Sunlit heritage bungalow", city: "Mumbai", booking_type: "Hourly", when: "21 Nov 2026, 10:00–14:00", payment_ref: "pb_3f2a9c1b", payment_method: "UPI", paid_at: now },
    currency: "INR",
    subtotal_minor_units: 600_000,
    discount_minor_units: 60_000,
    coupon_code: "MONSOON10",
    service_fee_minor_units: 27_000,
    tax_minor_units: 102_060,
    tax_rate_bps: 1800,
    total_minor_units: 669_060,
    tax_label: settings.tax_label,
    sac_code: settings.sac_code,
    delivery_status: "pending",
    sent_via: null,
    sent_at: null,
    sent_to: null,
    send_count: 0,
    last_error: null,
  };
  return renderPdf(invoicePdfInput(sample, settings));
}

// -- Sending -------------------------------------------------------------------------------------------

export async function getInvoice(id: string): Promise<Invoice> {
  const { data, error } = await adminClient.from("invoices").select(INVOICE_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError("Invoice not found.");
  return data as Invoice;
}

export async function emailReady(): Promise<boolean> {
  return Boolean(await smtpCredentials().catch(() => null));
}

/** Emails the invoice PDF. `via: "auto"` on issue; "manual" when someone on the team sends it. */
export async function sendInvoice(id: string, opts: { via: "auto" | "manual"; to?: string | null; actorId?: string }): Promise<Invoice> {
  const invoice = await getInvoice(id);
  const to = opts.to?.trim() || invoice.billed_to.email;
  if (!to) throw new ValidationError("This booker has no email address. Enter one to send it to.");
  if (!(await emailReady())) {
    if (opts.via === "manual") throw new ValidationError("Email isn't connected. Connect an SMTP server under Messaging → Email first.");
    return invoice; // stays pending
  }
  const pdf = Buffer.from(await invoicePdf(invoice));
  const sellerName = invoice.seller.name;
  const total = `INR ${(invoice.total_minor_units / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
  try {
    await sendEmail({
      to,
      subject: `Invoice ${invoice.number} from ${sellerName}`,
      text: `Hi ${invoice.billed_to.name},\n\nThanks for your booking at ${invoice.details.listing} (${invoice.details.when}). Your invoice ${invoice.number} for ${total} is attached.\n\n${sellerName}`,
      html: `<p>Hi ${escapeHtml(invoice.billed_to.name)},</p><p>Thanks for your booking at <strong>${escapeHtml(invoice.details.listing)}</strong> (${escapeHtml(invoice.details.when)}). Your invoice <strong>${escapeHtml(invoice.number)}</strong> for ${escapeHtml(total)} is attached.</p><p>${escapeHtml(sellerName)}</p>`,
      attachments: [{ filename: `${invoice.number.replace(/\//g, "-")}.pdf`, content: pdf, contentType: "application/pdf" }],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "Sending failed.";
    await adminClient.from("invoices").update({ delivery_status: "failed", last_error: message }).eq("id", id);
    await adminClient.from("invoice_events").insert({ invoice_id: id, kind: "failed", to_email: to, actor_id: opts.actorId ?? null, error: message });
    if (opts.via === "manual") throw new ValidationError(`The email didn't go: ${message}`);
    return getInvoice(id);
  }
  await adminClient
    .from("invoices")
    .update({ delivery_status: "sent", sent_via: opts.via, sent_at: new Date().toISOString(), sent_to: to, send_count: invoice.send_count + 1, last_error: null })
    .eq("id", id);
  await adminClient.from("invoice_events").insert({ invoice_id: id, kind: opts.via === "auto" ? "sent_auto" : "sent_manual", to_email: to, actor_id: opts.actorId ?? null });
  return getInvoice(id);
}

// -- Lists -----------------------------------------------------------------------------------------------

export type InvoiceFilter = "all" | "pending" | "sent_auto" | "sent_manual" | "failed";

export async function listInvoices(q: { filter: InvoiceFilter; search?: string; page: number; pageSize: number }): Promise<{ data: Invoice[]; total: number }> {
  const from = (q.page - 1) * q.pageSize;
  let query = adminClient.from("invoices").select(INVOICE_COLUMNS, { count: "exact" }).order("issued_at", { ascending: false }).range(from, from + q.pageSize - 1);
  if (q.filter === "pending") query = query.eq("delivery_status", "pending");
  if (q.filter === "failed") query = query.eq("delivery_status", "failed");
  if (q.filter === "sent_auto") query = query.eq("delivery_status", "sent").eq("sent_via", "auto");
  if (q.filter === "sent_manual") query = query.eq("delivery_status", "sent").eq("sent_via", "manual");
  if (q.search) {
    const term = q.search.replace(/[%,()]/g, "");
    query = query.or(`number.ilike.%${term}%,sent_to.ilike.%${term}%,billed_to->>name.ilike.%${term}%,billed_to->>email.ilike.%${term}%`);
  }
  const { data, error, count } = await query;
  if (error) throw error;
  return { data: (data ?? []) as Invoice[], total: count ?? 0 };
}

export async function invoiceCounts(): Promise<Record<InvoiceFilter | "waiting", number>> {
  const count = async (f: (q: ReturnType<typeof base>) => ReturnType<typeof base>) => (await f(base())).count ?? 0;
  const base = () => adminClient.from("invoices").select("id", { count: "exact", head: true });
  const [all, pending, failed, sentAuto, sentManual, waiting] = await Promise.all([
    count((q) => q),
    count((q) => q.eq("delivery_status", "pending")),
    count((q) => q.eq("delivery_status", "failed")),
    count((q) => q.eq("delivery_status", "sent").eq("sent_via", "auto")),
    count((q) => q.eq("delivery_status", "sent").eq("sent_via", "manual")),
    paymentsWithoutInvoice().then((p) => p.length),
  ]);
  return { all, pending, failed, sent_auto: sentAuto, sent_manual: sentManual, waiting };
}

export async function invoiceEvents(id: string) {
  const { data, error } = await adminClient
    .from("invoice_events")
    .select("id, kind, to_email, error, created_at, actor:profiles!actor_id(first_name, last_name)")
    .eq("invoice_id", id)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/** Paid bookings that don't have an invoice yet (e.g. paid before the template was filled in). */
async function paymentsWithoutInvoice(): Promise<string[]> {
  const [{ data: pays, error }, { data: invs, error: e2 }] = await Promise.all([
    adminClient.from("payments").select("id, booking_id").in("status", SETTLED).order("created_at", { ascending: true }).limit(5000),
    adminClient.from("invoices").select("booking_id").limit(20000),
  ]);
  if (error) throw error;
  if (e2) throw e2;
  const have = new Set((invs ?? []).map((i: { booking_id: string }) => i.booking_id));
  const out: string[] = [];
  for (const p of (pays ?? []) as { id: string; booking_id: string }[]) {
    if (have.has(p.booking_id)) continue;
    have.add(p.booking_id);
    out.push(p.id);
  }
  return out;
}

/**
 * Issues every missing invoice. They're left "pending to send" rather than emailed, so bookings paid
 * long ago don't all get an email at once: the team reviews them and sends them from the list.
 */
export async function issueMissingInvoices(): Promise<{ issued: number }> {
  const settings = await getInvoiceSettings();
  const missing = missingSettings(settings);
  if (missing.length) throw new ValidationError(`Fill in the invoice template first (${missing.join(", ")}).`);
  let issued = 0;
  for (const paymentId of await paymentsWithoutInvoice()) {
    if (await issueInvoiceForPayment(paymentId, { send: false })) issued++;
  }
  return { issued };
}

/** Sends every invoice still waiting to be emailed. */
export async function sendPending(actorId: string): Promise<{ sent: number; failed: number }> {
  if (!(await emailReady())) throw new ValidationError("Email isn't connected. Connect an SMTP server under Messaging → Email first.");
  const { data } = await adminClient.from("invoices").select("id").in("delivery_status", ["pending", "failed"]).limit(500);
  let sent = 0;
  let failed = 0;
  for (const { id } of (data ?? []) as { id: string }[]) {
    const inv = await sendInvoice(id, { via: "manual", actorId }).catch(() => null);
    if (inv?.delivery_status === "sent") sent++;
    else failed++;
  }
  return { sent, failed };
}

// -- The booker's own ------------------------------------------------------------------------------------

export async function myInvoices(userId: string): Promise<Pick<Invoice, "id" | "number" | "booking_id" | "issued_at" | "total_minor_units" | "currency">[]> {
  const { data, error } = await adminClient.from("invoices").select("id, number, booking_id, issued_at, total_minor_units, currency").eq("user_id", userId).order("issued_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Pick<Invoice, "id" | "number" | "booking_id" | "issued_at" | "total_minor_units" | "currency">[];
}

export async function myInvoice(userId: string, id: string): Promise<Invoice> {
  const invoice = await getInvoice(id);
  if (invoice.user_id !== userId) throw new NotFoundError("Invoice not found.");
  return invoice;
}

// -- Receipts (proof of payment, any settled payment) ----------------------------------------------------

export interface ReceiptRow {
  payment_id: string;
  booking_id: string;
  amount_minor_units: number;
  refunded_minor_units: number;
  currency: string;
  status: string;
  method: string | null;
  paid_at: string;
  booker: { id: string; first_name: string | null; last_name: string | null } | null;
  listing: string | null;
  invoice_number: string | null;
  last_sent_at: string | null;
}

export async function listReceipts(q: { page: number; pageSize: number }): Promise<{ data: ReceiptRow[]; total: number }> {
  const from = (q.page - 1) * q.pageSize;
  const { data, error, count } = await adminClient
    .from("payments")
    .select(
      `id, booking_id, amount_minor_units, currency, status, method, updated_at,
       payment_refunds(amount_minor_units, status),
       booking:bookings(booker:profiles!booker_id(id, first_name, last_name), location:locations(title)),
       invoice_events(kind, created_at)`,
      { count: "exact" }
    )
    .in("status", SETTLED)
    .order("updated_at", { ascending: false })
    .range(from, from + q.pageSize - 1);
  if (error) throw error;
  const rows = (data ?? []) as unknown as {
    id: string;
    booking_id: string;
    amount_minor_units: number;
    currency: string;
    status: string;
    method: string | null;
    updated_at: string;
    payment_refunds: { amount_minor_units: number; status: string }[] | null;
    booking: { booker: ReceiptRow["booker"]; location: { title: string } | null } | null;
    invoice_events: { kind: string; created_at: string }[] | null;
  }[];
  const { data: invs } = await adminClient.from("invoices").select("booking_id, number").in("booking_id", rows.map((r) => r.booking_id));
  const numbers = new Map((invs ?? []).map((i: { booking_id: string; number: string }) => [i.booking_id, i.number]));
  return {
    total: count ?? 0,
    data: rows.map((r) => ({
      payment_id: r.id,
      booking_id: r.booking_id,
      amount_minor_units: r.amount_minor_units,
      refunded_minor_units: (r.payment_refunds ?? []).filter((x) => x.status === "success").reduce((s, x) => s + x.amount_minor_units, 0),
      currency: r.currency,
      status: r.status,
      method: r.method,
      paid_at: r.updated_at,
      booker: r.booking?.booker ?? null,
      listing: r.booking?.location?.title ?? null,
      invoice_number: numbers.get(r.booking_id) ?? null,
      last_sent_at: (r.invoice_events ?? []).filter((e) => e.kind === "receipt_sent").map((e) => e.created_at).sort().at(-1) ?? null,
    })),
  };
}

export async function receiptPdf(paymentId: string): Promise<{ pdf: Uint8Array; to: string | null; name: string; filename: string }> {
  const paid = await loadPaid(paymentId);
  if (!paid) throw new NotFoundError("Payment not found.");
  const settings = await getInvoiceSettings();
  const billed = await billedToFor(paid.booking.booker_id);
  const { data: refunds } = await adminClient.from("payment_refunds").select("amount_minor_units, status, created_at").eq("payment_id", paymentId);
  const refunded = ((refunds ?? []) as { amount_minor_units: number; status: string }[]).filter((r) => r.status === "success").reduce((s, r) => s + r.amount_minor_units, 0);
  const { data: inv } = await adminClient.from("invoices").select("number").eq("booking_id", paid.booking.id).maybeSingle();
  const b = paid.booking;
  const ref = `RCPT-${paid.payment.id.slice(0, 8).toUpperCase()}`;
  const pdf = await renderPdf({
    title: "PAYMENT RECEIPT",
    number: ref,
    date: fmtDate(paid.payment.updated_at),
    seller: { name: sellerFrom(settings).name || "Receipt", lines: partyLines(sellerFrom(settings), "seller") },
    billedTo: { name: billed.name, lines: partyLines(billed, "buyer") },
    details: [
      ["Booking", b.id.slice(0, 8).toUpperCase()],
      ["Location", placeLabel(b.location?.title, b.location?.city)],
      ["When", when(b.start_at, b.end_at, b.location?.timezone ?? "Asia/Kolkata")],
      ["Method", paid.payment.method ? (METHOD_LABEL[paid.payment.method] ?? paid.payment.method) : "Online"],
      ...(paid.payment.provider_order_id ? ([["Payment ref", paid.payment.provider_order_id]] as [string, string][]) : []),
      ...(inv ? ([["Invoice", (inv as { number: string }).number]] as [string, string][]) : []),
    ],
    lines: [{ description: `Payment received for booking ${b.id.slice(0, 8).toUpperCase()}`, amount: paid.payment.amount_minor_units }],
    totals: [
      { label: "Paid", amount: paid.payment.amount_minor_units },
      ...(refunded ? [{ label: "Refunded", amount: refunded, negative: true }, { label: "Net paid (INR)", amount: paid.payment.amount_minor_units - refunded, strong: true }] : [{ label: "Total paid (INR)", amount: paid.payment.amount_minor_units, strong: true }]),
    ],
    amountInWords: amountInWords(paid.payment.amount_minor_units - refunded),
    footer: `${ref} · This receipt confirms the payment above. The tax invoice is issued separately.`,
  });
  return { pdf, to: billed.email ?? null, name: billed.name, filename: `${ref}.pdf` };
}

export async function sendReceipt(paymentId: string, opts: { to?: string | null; actorId: string }): Promise<{ to: string }> {
  if (!(await emailReady())) throw new ValidationError("Email isn't connected. Connect an SMTP server under Messaging → Email first.");
  const r = await receiptPdf(paymentId);
  const to = opts.to?.trim() || r.to;
  if (!to) throw new ValidationError("This booker has no email address. Enter one to send it to.");
  await sendEmail({
    to,
    subject: "Your payment receipt",
    text: `Hi ${r.name},\n\nYour payment receipt is attached.`,
    html: `<p>Hi ${escapeHtml(r.name)},</p><p>Your payment receipt is attached.</p>`,
    attachments: [{ filename: r.filename, content: Buffer.from(r.pdf), contentType: "application/pdf" }],
  });
  await adminClient.from("invoice_events").insert({ payment_id: paymentId, kind: "receipt_sent", to_email: to, actor_id: opts.actorId });
  return { to };
}

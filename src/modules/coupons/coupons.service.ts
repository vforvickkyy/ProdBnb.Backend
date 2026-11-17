import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import type { AdminCreateCouponInput, CreateCouponInput, ListCouponsQuery, UpdateCouponInput } from "./coupons.schema";

/**
 * Coupons and offers. A discount comes off the listing price (before the service fee and tax).
 * Who pays for it follows who created it: ProdBnb ("platform") or the host ("host").
 */
export type CouponOwner = "platform" | "host";
export type CouponStatus = "active" | "scheduled" | "ended" | "inactive" | "used_up";

export interface Coupon {
  id: string;
  code: string;
  owner_type: CouponOwner;
  host_id: string | null;
  title: string;
  description: string | null;
  discount_type: "percent" | "fixed";
  percent_off: number | null;
  amount_off_minor_units: number | null;
  max_discount_minor_units: number | null;
  min_booking_minor_units: number | null;
  booking_types: string[] | null;
  starts_at: string | null;
  ends_at: string | null;
  usage_limit: number | null;
  per_user_limit: number | null;
  first_booking_only: boolean;
  is_public: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  location_ids: string[];
}

export interface CouponWithStats extends Coupon {
  status: CouponStatus;
  uses: number;
  discount_given_minor_units: number;
  host: { id: string; first_name: string | null; last_name: string | null } | null;
}

const COLUMNS = `id, code, owner_type, host_id, title, description, discount_type, percent_off, amount_off_minor_units,
  max_discount_minor_units, min_booking_minor_units, booking_types, starts_at, ends_at, usage_limit, per_user_limit,
  first_booking_only, is_public, is_active, created_at, updated_at, coupon_locations(location_id)`;

type Raw = Omit<Coupon, "location_ids"> & { coupon_locations: { location_id: string }[] | null };
const toCoupon = ({ coupon_locations, ...c }: Raw): Coupon => ({ ...c, location_ids: (coupon_locations ?? []).map((l) => l.location_id) });

const SETTLED = new Set(["success", "partially_refunded", "refunded"]);

/** Redemptions that count: the booking is live, or it was paid (a later cancellation doesn't give the use back). */
async function usage(couponIds: string[]): Promise<Map<string, { uses: number; discount: number; users: Map<string, number> }>> {
  const out = new Map<string, { uses: number; discount: number; users: Map<string, number> }>();
  if (couponIds.length === 0) return out;
  const { data, error } = await adminClient
    .from("coupon_redemptions")
    .select("coupon_id, user_id, discount_minor_units, booking:bookings(status, payments(status))")
    .in("coupon_id", couponIds);
  if (error) throw error;
  for (const r of (data ?? []) as unknown as { coupon_id: string; user_id: string; discount_minor_units: number; booking: { status: string; payments: { status: string }[] | null } | null }[]) {
    const paid = (r.booking?.payments ?? []).some((p) => SETTLED.has(p.status));
    const live = r.booking && ["requested", "confirmed", "completed"].includes(r.booking.status);
    if (!paid && !live) continue;
    const u = out.get(r.coupon_id) ?? { uses: 0, discount: 0, users: new Map() };
    u.uses += 1;
    u.discount += paid ? r.discount_minor_units : 0;
    u.users.set(r.user_id, (u.users.get(r.user_id) ?? 0) + 1);
    out.set(r.coupon_id, u);
  }
  return out;
}

export function couponStatus(c: Pick<Coupon, "is_active" | "starts_at" | "ends_at" | "usage_limit">, uses: number, now = Date.now()): CouponStatus {
  if (!c.is_active) return "inactive";
  if (c.ends_at && new Date(c.ends_at).getTime() <= now) return "ended";
  if (c.usage_limit !== null && uses >= c.usage_limit) return "used_up";
  if (c.starts_at && new Date(c.starts_at).getTime() > now) return "scheduled";
  return "active";
}

/** What a coupon takes off a listing price. Never more than the price itself. */
export function discountFor(c: Pick<Coupon, "discount_type" | "percent_off" | "amount_off_minor_units" | "max_discount_minor_units">, base: number): number {
  let d = c.discount_type === "percent" ? Math.round((base * (c.percent_off ?? 0)) / 100) : (c.amount_off_minor_units ?? 0);
  if (c.max_discount_minor_units) d = Math.min(d, c.max_discount_minor_units);
  return Math.max(0, Math.min(d, base));
}

const rupees = (minor: number) => `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const TYPE_WORD: Record<string, string> = { hourly: "hourly", half_day: "half-day", day: "full-day", multi_day: "multi-day" };

export interface AppliedCoupon {
  coupon: Coupon;
  discount: number;
}

/**
 * Checks a code for one booking and works out its discount, or says (in words a booker
 * understands) why it doesn't apply.
 */
export async function resolveCoupon(
  rawCode: string,
  ctx: { locationId: string; hostId: string; bookingType: string; baseMinor: number; userId: string },
  now = Date.now()
): Promise<AppliedCoupon | { error: string }> {
  const code = rawCode.trim().toUpperCase().replace(/\s+/g, "");
  const { data, error } = await adminClient.from("coupons").select(COLUMNS).eq("code", code).maybeSingle();
  if (error) throw error;
  if (!data) return { error: "That code isn't valid." };
  const c = toCoupon(data as unknown as Raw);
  if (!c.is_active) return { error: "That code isn't valid." };
  if (c.starts_at && new Date(c.starts_at).getTime() > now) return { error: `That offer starts on ${new Date(c.starts_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}.` };
  if (c.ends_at && new Date(c.ends_at).getTime() <= now) return { error: "That offer has ended." };
  if (c.owner_type === "host" && c.host_id !== ctx.hostId) return { error: "That code doesn't apply to this place." };
  if (c.location_ids.length > 0 && !c.location_ids.includes(ctx.locationId)) return { error: "That code doesn't apply to this place." };
  if (c.booking_types && !c.booking_types.includes(ctx.bookingType)) return { error: `That code doesn't apply to ${TYPE_WORD[ctx.bookingType] ?? ctx.bookingType} bookings.` };
  if (c.min_booking_minor_units && ctx.baseMinor < c.min_booking_minor_units) return { error: `That code needs a booking of at least ${rupees(c.min_booking_minor_units)} (before fees).` };

  const u = (await usage([c.id])).get(c.id);
  if (c.usage_limit !== null && (u?.uses ?? 0) >= c.usage_limit) return { error: "That code has been fully used." };
  if (c.per_user_limit !== null && (u?.users.get(ctx.userId) ?? 0) >= c.per_user_limit) return { error: "You've already used that code." };
  if (c.first_booking_only) {
    const { data: prior } = await adminClient.from("bookings").select("id, payments!inner(status)").eq("booker_id", ctx.userId).in("payments.status", [...SETTLED]).limit(1);
    if ((prior ?? []).length > 0) return { error: "That code is for your first booking." };
  }
  const discount = discountFor(c, ctx.baseMinor);
  if (discount <= 0) return { error: "That code doesn't take anything off this booking." };
  return { coupon: c, discount };
}

export async function recordRedemption(applied: AppliedCoupon, bookingId: string, userId: string): Promise<void> {
  const { error } = await adminClient.from("coupon_redemptions").insert({
    coupon_id: applied.coupon.id,
    booking_id: bookingId,
    user_id: userId,
    discount_minor_units: applied.discount,
    funded_by: applied.coupon.owner_type,
  });
  if (error) throw error;
}

// -- Listing and managing ------------------------------------------------------------------------

async function withStats(coupons: Coupon[]): Promise<CouponWithStats[]> {
  const stats = await usage(coupons.map((c) => c.id));
  const hostIds = [...new Set(coupons.map((c) => c.host_id).filter((x): x is string => Boolean(x)))];
  const hosts = new Map<string, { id: string; first_name: string | null; last_name: string | null }>();
  if (hostIds.length) {
    const { data } = await adminClient.from("profiles").select("id, first_name, last_name").in("id", hostIds);
    for (const h of (data ?? []) as { id: string; first_name: string | null; last_name: string | null }[]) hosts.set(h.id, h);
  }
  return coupons.map((c) => {
    const s = stats.get(c.id);
    return { ...c, uses: s?.uses ?? 0, discount_given_minor_units: s?.discount ?? 0, status: couponStatus(c, s?.uses ?? 0), host: c.host_id ? (hosts.get(c.host_id) ?? null) : null };
  });
}

export async function listCoupons(query: ListCouponsQuery, scopeHostId?: string): Promise<{ data: CouponWithStats[]; total: number }> {
  let q = adminClient.from("coupons").select(COLUMNS).order("created_at", { ascending: false }).limit(1000);
  if (scopeHostId) q = q.eq("host_id", scopeHostId);
  else if (query.owner !== "all") q = q.eq("owner_type", query.owner);
  if (query.host_id && !scopeHostId) q = q.eq("host_id", query.host_id);
  if (query.search) q = q.or(`code.ilike.%${query.search.replace(/[%,()]/g, "")}%,title.ilike.%${query.search.replace(/[%,()]/g, "")}%`);
  const { data, error } = await q;
  if (error) throw error;
  let rows = await withStats(((data ?? []) as unknown as Raw[]).map(toCoupon));
  if (query.status !== "all") rows = rows.filter((c) => (query.status === "ended" ? c.status === "ended" || c.status === "used_up" : c.status === query.status));
  const from = (query.page - 1) * query.pageSize;
  return { data: rows.slice(from, from + query.pageSize), total: rows.length };
}

export interface Redemption {
  id: string;
  booking_id: string;
  discount_minor_units: number;
  funded_by: CouponOwner;
  created_at: string;
  booking: { status: string; start_at: string; paid: boolean; location: { id: string; title: string } | null } | null;
  booker: { first_name: string | null; last_name: string | null } | null;
}

export async function getCoupon(id: string, scopeHostId?: string): Promise<CouponWithStats & { redemptions: Redemption[] }> {
  const { data, error } = await adminClient.from("coupons").select(COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError("Coupon not found.");
  const coupon = toCoupon(data as unknown as Raw);
  if (scopeHostId && coupon.host_id !== scopeHostId) throw new NotFoundError("Coupon not found.");
  const [withS] = await withStats([coupon]);
  const { data: reds, error: e2 } = await adminClient
    .from("coupon_redemptions")
    .select("id, booking_id, discount_minor_units, funded_by, created_at, booking:bookings(status, start_at, payments(status), location:locations(id, title)), booker:profiles!user_id(first_name, last_name)")
    .eq("coupon_id", id)
    .order("created_at", { ascending: false })
    .limit(500);
  if (e2) throw e2;
  const redemptions = ((reds ?? []) as unknown as (Omit<Redemption, "booking"> & { booking: { status: string; start_at: string; payments: { status: string }[] | null; location: { id: string; title: string } | null } | null })[]).map((r) => ({
    ...r,
    booking: r.booking ? { status: r.booking.status, start_at: r.booking.start_at, paid: (r.booking.payments ?? []).some((p) => SETTLED.has(p.status)), location: r.booking.location } : null,
  }));
  return { ...withS!, redemptions };
}

async function assertHostLocations(hostId: string, locationIds: string[]): Promise<void> {
  if (locationIds.length === 0) return;
  const { data, error } = await adminClient.from("locations").select("id, host_id").in("id", locationIds);
  if (error) throw error;
  const rows = (data ?? []) as { id: string; host_id: string }[];
  if (rows.length !== new Set(locationIds).size || rows.some((r) => r.host_id !== hostId)) {
    throw new ValidationError("A coupon can only cover the host's own listings.");
  }
}

async function setLocations(couponId: string, locationIds: string[]): Promise<void> {
  await adminClient.from("coupon_locations").delete().eq("coupon_id", couponId);
  if (locationIds.length) {
    const { error } = await adminClient.from("coupon_locations").insert([...new Set(locationIds)].map((location_id) => ({ coupon_id: couponId, location_id })));
    if (error) throw error;
  }
}

function columnsFrom(input: Partial<CreateCouponInput>) {
  const { location_ids: _l, ...rest } = input as Partial<CreateCouponInput> & { owner_type?: unknown; host_id?: unknown };
  delete (rest as Record<string, unknown>).owner_type;
  delete (rest as Record<string, unknown>).host_id;
  return rest;
}

export async function createCoupon(input: CreateCouponInput | AdminCreateCouponInput, owner: { type: CouponOwner; hostId: string | null; createdBy: string }): Promise<CouponWithStats> {
  if (owner.type === "host") await assertHostLocations(owner.hostId!, input.location_ids ?? []);
  const { data, error } = await adminClient
    .from("coupons")
    .insert({ ...columnsFrom(input), owner_type: owner.type, host_id: owner.hostId, created_by: owner.createdBy })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") throw new ConflictError("That code is already taken. Pick another.");
    throw error;
  }
  const id = (data as { id: string }).id;
  await setLocations(id, input.location_ids ?? []);
  return getCoupon(id);
}

export async function updateCoupon(id: string, input: UpdateCouponInput, scopeHostId?: string): Promise<CouponWithStats> {
  const current = await getCoupon(id, scopeHostId);
  const merged = { ...current, ...input };
  if (merged.discount_type === "percent" && (!merged.percent_off || merged.amount_off_minor_units)) {
    if (input.discount_type === "percent") merged.amount_off_minor_units = null;
    if (!merged.percent_off) throw new ValidationError("A percentage coupon needs percent_off.");
  }
  if (merged.discount_type === "fixed" && (!merged.amount_off_minor_units || merged.percent_off || merged.max_discount_minor_units)) {
    if (input.discount_type === "fixed") {
      merged.percent_off = null;
      merged.max_discount_minor_units = null;
    }
    if (!merged.amount_off_minor_units) throw new ValidationError("A fixed coupon needs amount_off_minor_units.");
  }
  if (current.owner_type === "host" && input.location_ids) await assertHostLocations(current.host_id!, input.location_ids);
  const patch = {
    ...columnsFrom(input),
    ...(merged.discount_type === "percent" ? { amount_off_minor_units: null } : { percent_off: null, max_discount_minor_units: null }),
  };
  const { error } = await adminClient.from("coupons").update(patch).eq("id", id);
  if (error) {
    if (error.code === "23505") throw new ConflictError("That code is already taken. Pick another.");
    if (error.code === "23514") throw new ValidationError("Those settings don't fit together. Check the discount and dates.");
    throw error;
  }
  if (input.location_ids) await setLocations(id, input.location_ids);
  return getCoupon(id);
}

export async function deleteCoupon(id: string, scopeHostId?: string): Promise<void> {
  await getCoupon(id, scopeHostId);
  const { count } = await adminClient.from("coupon_redemptions").select("id", { count: "exact", head: true }).eq("coupon_id", id);
  if ((count ?? 0) > 0) throw new ConflictError("This coupon has been used, so it's kept for the records. Turn it off instead.");
  const { error } = await adminClient.from("coupons").delete().eq("id", id);
  if (error) throw error;
}

// -- Public offers -------------------------------------------------------------------------------

export interface PublicOffer {
  code: string;
  title: string;
  description: string | null;
  owner_type: CouponOwner;
  discount_type: "percent" | "fixed";
  percent_off: number | null;
  amount_off_minor_units: number | null;
  max_discount_minor_units: number | null;
  min_booking_minor_units: number | null;
  booking_types: string[] | null;
  ends_at: string | null;
  first_booking_only: boolean;
  /** Host offers: the listings they cover (all of that host's live listings when not limited). */
  locations: { id: string; title: string; city: string | null }[];
}

async function livePublic(): Promise<CouponWithStats[]> {
  const { data, error } = await adminClient.from("coupons").select(COLUMNS).eq("is_public", true).eq("is_active", true).limit(500);
  if (error) throw error;
  return (await withStats(((data ?? []) as unknown as Raw[]).map(toCoupon))).filter((c) => c.status === "active");
}

function toOffer(c: Coupon, locations: PublicOffer["locations"]): PublicOffer {
  return {
    code: c.code,
    title: c.title,
    description: c.description,
    owner_type: c.owner_type,
    discount_type: c.discount_type,
    percent_off: c.percent_off,
    amount_off_minor_units: c.amount_off_minor_units,
    max_discount_minor_units: c.max_discount_minor_units,
    min_booking_minor_units: c.min_booking_minor_units,
    booking_types: c.booking_types,
    ends_at: c.ends_at,
    first_booking_only: c.first_booking_only,
    locations,
  };
}

/** Public offers that work on one listing (shown on its page and at checkout). */
export async function offersForLocation(locationId: string): Promise<PublicOffer[]> {
  const { data: loc } = await adminClient.from("locations").select("id, host_id, status").eq("id", locationId).maybeSingle();
  if (!loc || (loc as { status: string }).status !== "published") throw new NotFoundError("Location not found.");
  const hostId = (loc as { host_id: string }).host_id;
  return (await livePublic())
    .filter((c) => (c.owner_type === "platform" || c.host_id === hostId) && (c.location_ids.length === 0 || c.location_ids.includes(locationId)))
    .map((c) => toOffer(c, []));
}

/** Every live public offer, for the Offers page. */
export async function allOffers(): Promise<PublicOffer[]> {
  const coupons = await livePublic();
  const out: PublicOffer[] = [];
  for (const c of coupons) {
    let locations: PublicOffer["locations"] = [];
    if (c.owner_type === "host") {
      let q = adminClient.from("locations").select("id, title, city").eq("status", "published").limit(6);
      q = c.location_ids.length ? q.in("id", c.location_ids) : q.eq("host_id", c.host_id!);
      const { data } = await q;
      locations = (data ?? []) as PublicOffer["locations"];
      if (locations.length === 0) continue;
    } else if (c.location_ids.length) {
      const { data } = await adminClient.from("locations").select("id, title, city").eq("status", "published").in("id", c.location_ids).limit(6);
      locations = (data ?? []) as PublicOffer["locations"];
    }
    out.push(toOffer(c, locations));
  }
  // ProdBnb offers first, then the soonest-ending.
  return out.sort((a, b) => (a.owner_type === b.owner_type ? (a.ends_at ?? "9999").localeCompare(b.ends_at ?? "9999") : a.owner_type === "platform" ? -1 : 1));
}

export function assertHost(isHost: boolean): void {
  if (!isHost) throw new ForbiddenError("Only hosts can create offers.");
}

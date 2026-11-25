import { adminClient } from "../../lib/supabase";

/** Everything an email about one booking may show, loaded fresh when the email is sent. */
export interface BookingContext {
  id: string;
  ref: string;
  status: string;
  pricing_status: string | null;
  booking_type: string | null;
  start_at: string;
  end_at: string;
  base_amount_minor_units: number;
  platform_fee_minor_units: number;
  tax_minor_units: number;
  discount_minor_units: number;
  total_amount_minor_units: number;
  currency: string;
  crew_size: number | null;
  shoot_type: string | null;
  project_name: string | null;
  production_name: string | null;
  shoot_notes: string | null;
  cancellation_reason: string | null;
  cancelled_by: string | null;
  booker_id: string;
  location: {
    id: string;
    title: string;
    city: string | null;
    area: string | null;
    address: string | null;
    timezone: string;
    host_id: string;
    instant_booking_enabled: boolean;
  };
  booker: Person;
  host: Person;
}

export interface Person {
  id: string;
  name: string;
  first_name: string;
  phone: string | null;
  email: string | null;
}

export async function emailOf(userId: string): Promise<string | null> {
  const { data } = await adminClient.auth.admin.getUserById(userId);
  return data?.user?.email ?? null;
}

export async function personOf(userId: string): Promise<Person> {
  const [{ data: profile }, email] = await Promise.all([
    adminClient.from("profiles").select("id, first_name, last_name, phone").eq("id", userId).maybeSingle(),
    emailOf(userId),
  ]);
  const first = (profile?.first_name as string | null)?.trim() || "";
  const last = (profile?.last_name as string | null)?.trim() || "";
  return {
    id: userId,
    first_name: first || "there",
    name: [first, last].filter(Boolean).join(" ") || email?.split("@")[0] || "A booker",
    phone: (profile?.phone as string | null) ?? null,
    email,
  };
}

export async function loadBooking(bookingId: string): Promise<BookingContext | null> {
  const { data, error } = await adminClient
    .from("bookings")
    .select(
      `id, status, pricing_status, booking_type, start_at, end_at, base_amount_minor_units, platform_fee_minor_units,
       tax_minor_units, discount_minor_units, total_amount_minor_units, currency, crew_size, shoot_type_id, shoot_type, project_name,
       production_name, shoot_notes, cancellation_reason, cancelled_by, booker_id,
       location:locations(id, title, city, area, address_line1, address_line2, timezone, host_id, instant_booking_enabled)`
    )
    .eq("id", bookingId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as unknown as Record<string, unknown> & {
    location: { id: string; title: string; city: string | null; area: string | null; address_line1: string | null; address_line2: string | null; timezone: string | null; host_id: string; instant_booking_enabled: boolean | null };
  };
  let shootType = (row.shoot_type as string | null) ?? null;
  if (!shootType && row.shoot_type_id) {
    const { data: useCase } = await adminClient.from("use_cases").select("name").eq("id", row.shoot_type_id as string).maybeSingle();
    shootType = (useCase?.name as string | undefined) ?? null;
  }
  const [booker, host] = await Promise.all([personOf(row.booker_id as string), personOf(row.location.host_id)]);
  return {
    id: row.id as string,
    ref: (row.id as string).slice(0, 8).toUpperCase(),
    status: row.status as string,
    pricing_status: (row.pricing_status as string | null) ?? null,
    booking_type: (row.booking_type as string | null) ?? null,
    start_at: row.start_at as string,
    end_at: row.end_at as string,
    base_amount_minor_units: (row.base_amount_minor_units as number) ?? 0,
    platform_fee_minor_units: (row.platform_fee_minor_units as number) ?? 0,
    tax_minor_units: (row.tax_minor_units as number) ?? 0,
    discount_minor_units: (row.discount_minor_units as number) ?? 0,
    total_amount_minor_units: (row.total_amount_minor_units as number) ?? 0,
    currency: (row.currency as string) ?? "INR",
    crew_size: (row.crew_size as number | null) ?? null,
    shoot_type: shootType,
    project_name: (row.project_name as string | null) ?? null,
    production_name: (row.production_name as string | null) ?? null,
    shoot_notes: (row.shoot_notes as string | null) ?? null,
    cancellation_reason: (row.cancellation_reason as string | null) ?? null,
    cancelled_by: (row.cancelled_by as string | null) ?? null,
    booker_id: row.booker_id as string,
    location: {
      id: row.location.id,
      title: row.location.title,
      city: row.location.city,
      area: row.location.area,
      address: [row.location.address_line1, row.location.address_line2].filter(Boolean).join(", ") || null,
      timezone: row.location.timezone ?? "Asia/Kolkata",
      host_id: row.location.host_id,
      instant_booking_enabled: Boolean(row.location.instant_booking_enabled),
    },
    booker,
    host,
  };
}

export async function loadLocation(locationId: string): Promise<{ id: string; title: string; city: string | null; status: string; moderation_reason: string | null; host_id: string; listing_code: string | null } | null> {
  const { data, error } = await adminClient
    .from("locations")
    .select("id, title, city, status, moderation_reason, host_id, listing_code")
    .eq("id", locationId)
    .maybeSingle();
  if (error) throw error;
  return (data as never) ?? null;
}

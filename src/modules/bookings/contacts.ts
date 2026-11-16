import { z } from "zod";
import { adminClient } from "../../lib/supabase";
import type { BookingDetail } from "./bookings.service";

/**
 * Who may contact whom, and when:
 *
 *  - the HOST sees the booker's phone and email once the booking is paid (a host only ever sees
 *    paid bookings anyway), so they can call before accepting;
 *  - the BOOKER sees the full address, the host's phone and email, and the listing's on-site
 *    contact and arrival notes once the booking is confirmed (or completed) and paid.
 *
 * Read with the service role, after the caller's relationship to the booking is established from
 * the booking they could already read.
 */
const SETTLED = new Set(["success", "partially_refunded", "refunded"]);

export interface BookingContact {
  address: {
    address_line1: string | null;
    address_line2: string | null;
    city: string | null;
    region: string | null;
    postal_code: string | null;
    country: string | null;
    latitude: number | null;
    longitude: number | null;
  };
  host: { first_name: string | null; last_name: string | null; phone: string | null; email: string | null };
  onsite: { name: string | null; phone: string | null } | null;
  arrival_notes: string | null;
}

export interface BookerContact {
  phone: string | null;
  email: string | null;
}

async function emailOf(userId: string): Promise<string | null> {
  const { data } = await adminClient.auth.admin.getUserById(userId);
  return data?.user?.email ?? null;
}

export async function withContacts(booking: BookingDetail, callerId: string): Promise<BookingDetail & { contact?: BookingContact; booker_contact?: BookerContact }> {
  const paid = booking.payments.some((p) => SETTLED.has(p.status));
  if (!paid) return booking;

  const { data: loc } = await adminClient
    .from("locations")
    .select("host_id, address_line1, address_line2, city, region, postal_code, country, latitude, longitude")
    .eq("id", booking.location.id)
    .maybeSingle();
  if (!loc) return booking;
  const location = loc as BookingContact["address"] & { host_id: string };

  if (callerId === location.host_id && callerId !== booking.booker_id) {
    const { data: p } = await adminClient.from("profiles").select("phone").eq("id", booking.booker_id).maybeSingle();
    return { ...booking, booker_contact: { phone: (p as { phone: string | null } | null)?.phone ?? null, email: await emailOf(booking.booker_id) } };
  }

  if (callerId === booking.booker_id && (booking.status === "confirmed" || booking.status === "completed")) {
    const [{ data: host }, { data: details }, hostEmail] = await Promise.all([
      adminClient.from("profiles").select("first_name, last_name, phone").eq("id", location.host_id).maybeSingle(),
      adminClient.from("location_private_details").select("onsite_contact_name, onsite_contact_phone, arrival_notes").eq("location_id", booking.location.id).maybeSingle(),
      emailOf(location.host_id),
    ]);
    const h = host as { first_name: string | null; last_name: string | null; phone: string | null } | null;
    const d = details as { onsite_contact_name: string | null; onsite_contact_phone: string | null; arrival_notes: string | null } | null;
    const { host_id: _hostId, ...address } = location;
    return {
      ...booking,
      contact: {
        address,
        host: { first_name: h?.first_name ?? null, last_name: h?.last_name ?? null, phone: h?.phone ?? null, email: hostEmail },
        onsite: d && (d.onsite_contact_name || d.onsite_contact_phone) ? { name: d.onsite_contact_name, phone: d.onsite_contact_phone } : null,
        arrival_notes: d?.arrival_notes ?? null,
      },
    };
  }
  return booking;
}

// -- The host's private details for a listing -----------------------------------------------------

const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()\-.]{5,32}$/, "Enter a phone number.")
  .refine((v) => (v.match(/\d/g) ?? []).length >= 5, "Enter a phone number.");

export const privateDetailsSchema = z
  .object({
    onsite_contact_name: z.string().trim().min(1).max(120).nullable(),
    onsite_contact_phone: phone.nullable(),
    arrival_notes: z.string().trim().max(2000).nullable(),
  })
  .strict();
export type PrivateDetailsInput = z.infer<typeof privateDetailsSchema>;

export async function getPrivateDetails(locationId: string) {
  const { data, error } = await adminClient
    .from("location_private_details")
    .select("onsite_contact_name, onsite_contact_phone, arrival_notes, updated_at")
    .eq("location_id", locationId)
    .maybeSingle();
  if (error) throw error;
  return data ?? { onsite_contact_name: null, onsite_contact_phone: null, arrival_notes: null, updated_at: null };
}

export async function savePrivateDetails(locationId: string, input: PrivateDetailsInput) {
  const row = {
    location_id: locationId,
    onsite_contact_name: input.onsite_contact_name || null,
    onsite_contact_phone: input.onsite_contact_phone || null,
    arrival_notes: input.arrival_notes || null,
  };
  const { error } = await adminClient.from("location_private_details").upsert(row, { onConflict: "location_id" });
  if (error) throw error;
  return getPrivateDetails(locationId);
}

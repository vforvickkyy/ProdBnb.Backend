import { randomUUID } from "crypto";
import { ValidationError } from "../../errors/AppError";
import { publicUrlFor, putObject } from "../../lib/r2";
import { adminClient } from "../../lib/supabase";
import { AVATAR_MAX_BYTES, AVATAR_TYPES, MyPaymentsQuery } from "./account.schema";

/** The booker's payment history across all their bookings (website account → Payments). */

export interface MyPayment {
  id: string;
  booking_id: string;
  status: string;
  amount_minor_units: number;
  currency: string;
  /** Coarse method family: "upi", "credit_card", "net_banking"... null until it settles. */
  method: string | null;
  refunded_minor_units: number;
  created_at: string;
  updated_at: string;
  booking: {
    id: string;
    status: string;
    booking_type: string;
    start_at: string;
    end_at: string;
    location: { id: string; title: string; city: string | null } | null;
  };
}

export async function listMyPayments(userId: string, query: MyPaymentsQuery): Promise<{ data: MyPayment[]; total: number }> {
  const from = (query.page - 1) * query.pageSize;
  const { data, error, count } = await adminClient
    .from("payments")
    .select(
      `id, booking_id, status, amount_minor_units, currency, method, created_at, updated_at,
       booking:bookings!inner(id, status, booking_type, start_at, end_at, booker_id, location:locations(id, title, city)),
       refunds:payment_refunds(amount_minor_units, status)`,
      { count: "exact" }
    )
    .eq("booking.booker_id", userId)
    // Attempts that never got anywhere are noise in a payment history.
    .not("status", "in", "(created)")
    .order("created_at", { ascending: false })
    .range(from, from + query.pageSize - 1);
  if (error) throw error;
  type Row = Omit<MyPayment, "refunded_minor_units" | "booking"> & {
    booking: MyPayment["booking"] & { booker_id?: string };
    refunds: { amount_minor_units: number; status: string }[] | null;
  };
  const rows = (data ?? []) as unknown as Row[];
  return {
    data: rows.map(({ refunds, booking, ...rest }) => {
      const { booker_id: _owner, ...bookingSummary } = booking;
      return {
        ...rest,
        booking: bookingSummary,
        refunded_minor_units: (refunds ?? []).filter((r) => r.status === "success").reduce((sum, r) => sum + r.amount_minor_units, 0),
      };
    }),
    total: count ?? rows.length,
  };
}

/**
 * Profile photo, uploaded through the backend so the browser never needs storage credentials or
 * bucket CORS. The bytes are checked against the declared type (magic numbers), not trusted.
 */
export async function uploadAvatar(userId: string, contentType: string | undefined, body: unknown): Promise<string> {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = AVATAR_TYPES[type];
  if (!ext) throw new ValidationError("Upload a JPEG, PNG or WebP image.");
  if (!Buffer.isBuffer(body) || body.length === 0) throw new ValidationError("The image is empty.");
  if (body.length > AVATAR_MAX_BYTES) throw new ValidationError("The image must be 2 MB or smaller.");
  if (!matchesSignature(type, body)) throw new ValidationError("That file isn't a valid image.");

  const key = `avatars/${userId}/${randomUUID()}.${ext}`;
  await putObject(key, body, type);
  const url = publicUrlFor(key);
  const { error } = await adminClient.from("profiles").update({ avatar_url: url }).eq("id", userId);
  if (error) throw error;
  return url;
}

function matchesSignature(type: string, b: Buffer): boolean {
  if (type === "image/jpeg") return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === "image/png") return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === "image/webp") return b.length > 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

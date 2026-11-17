import { z } from "zod";

const uuid = z.string().uuid();
const bookingType = z.enum(["hourly", "half_day", "day", "multi_day"]);

export const couponCode = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase().replace(/\s+/g, ""))
  .refine((v) => /^[A-Z0-9][A-Z0-9_-]{2,29}$/.test(v), "Use 3–30 letters, numbers, - or _ (e.g. MONSOON10).");

const couponFields = {
  code: couponCode,
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  discount_type: z.enum(["percent", "fixed"]),
  percent_off: z.number().int().min(1).max(100).nullable().optional(),
  amount_off_minor_units: z.number().int().positive().nullable().optional(),
  max_discount_minor_units: z.number().int().positive().nullable().optional(),
  min_booking_minor_units: z.number().int().positive().nullable().optional(),
  booking_types: z.array(bookingType).min(1).max(4).nullable().optional(),
  starts_at: z.string().datetime({ offset: true }).nullable().optional(),
  ends_at: z.string().datetime({ offset: true }).nullable().optional(),
  usage_limit: z.number().int().positive().nullable().optional(),
  per_user_limit: z.number().int().positive().nullable().optional(),
  first_booking_only: z.boolean().optional(),
  is_public: z.boolean().optional(),
  is_active: z.boolean().optional(),
  /** Empty or omitted = every listing (a host's: every listing of theirs). */
  location_ids: z.array(uuid).max(200).optional(),
};

function shapeOk(d: { discount_type?: string; percent_off?: number | null; amount_off_minor_units?: number | null; max_discount_minor_units?: number | null }) {
  if (d.discount_type === "percent") return Boolean(d.percent_off) && !d.amount_off_minor_units;
  if (d.discount_type === "fixed") return Boolean(d.amount_off_minor_units) && !d.percent_off && !d.max_discount_minor_units;
  return true;
}
function datesOk(d: { starts_at?: string | null; ends_at?: string | null }) {
  return !d.starts_at || !d.ends_at || new Date(d.ends_at) > new Date(d.starts_at);
}

export const createCouponSchema = z
  .object(couponFields)
  .strict()
  .refine(shapeOk, { message: "A percentage coupon needs percent_off; a fixed one needs amount_off_minor_units (and no cap).", path: ["discount_type"] })
  .refine(datesOk, { message: "The end must be after the start.", path: ["ends_at"] });
export type CreateCouponInput = z.infer<typeof createCouponSchema>;

/** Admin: a ProdBnb coupon, or one on a host's behalf (owner_type host + host_id). */
export const adminCreateCouponSchema = z
  .object({ ...couponFields, owner_type: z.enum(["platform", "host"]).default("platform"), host_id: uuid.nullable().optional() })
  .strict()
  .refine(shapeOk, { message: "A percentage coupon needs percent_off; a fixed one needs amount_off_minor_units (and no cap).", path: ["discount_type"] })
  .refine(datesOk, { message: "The end must be after the start.", path: ["ends_at"] })
  .refine((d) => (d.owner_type === "host") === Boolean(d.host_id), { message: "A host coupon needs host_id (and a ProdBnb one must not have it).", path: ["host_id"] });
export type AdminCreateCouponInput = z.infer<typeof adminCreateCouponSchema>;

export const updateCouponSchema = z
  .object({ ...couponFields, code: couponCode.optional(), title: couponFields.title.optional(), discount_type: couponFields.discount_type.optional() })
  .strict()
  .refine(datesOk, { message: "The end must be after the start.", path: ["ends_at"] })
  .refine((d) => Object.keys(d).length > 0, { message: "Provide at least one field to update." });
export type UpdateCouponInput = z.infer<typeof updateCouponSchema>;

export const couponIdParamSchema = z.object({ id: uuid });

export const listCouponsQuerySchema = z.object({
  owner: z.enum(["platform", "host", "all"]).default("all"),
  status: z.enum(["active", "scheduled", "ended", "inactive", "all"]).default("all"),
  host_id: uuid.optional(),
  search: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListCouponsQuery = z.infer<typeof listCouponsQuerySchema>;

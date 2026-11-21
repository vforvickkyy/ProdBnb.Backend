import { z } from "zod";

const uuid = z.string().uuid();

// Validated with Intl rather than a fixed list — throws on anything that
// isn't a real IANA identifier (e.g. "IST"/"PST" abbreviations, which are
// deliberately not canonical timezone representations for this API).
export const ianaTimezoneSchema = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: "Must be a valid IANA timezone identifier, e.g. 'Asia/Kolkata'." }
);

// ISO-4217-shaped, not a fixed allowlist — keeps international expansion
// from requiring a migration, while still rejecting obvious garbage.
export const currencySchema = z.string().regex(/^[A-Z]{3}$/, "Must be a 3-letter ISO currency code, e.g. 'INR'.");

/**
 * The neighbourhood shown to everyone before booking (with the city), e.g. "Bandra West". The street
 * address, postcode and exact pin are only shown once a booking is confirmed and paid. Blank clears it.
 */
const areaSchema = z
  .string()
  .trim()
  .max(80)
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();

const blankToNull = (v: string | null | undefined): string | null => {
  if (v === undefined || v === null) return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
};

/** The internal listing ID (HKLS01): capital letters, numbers and hyphens, 2 to 20 characters. Team only. */
export const listingCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, "Use 2 to 20 capital letters, numbers or hyphens, for example HKLS07.");

export const propKindSchema = z.enum(["included", "addon"]);
export const propPriceUnitSchema = z.enum(["per_booking", "per_hour", "per_day"]);

/**
 * A prop that comes with the listing ("included") or that the host can provide for an extra price
 * ("addon"). An add-on may leave the price out ("ask the host"). Normalised so the stored JSON always
 * has the same shape.
 */
export const propSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: propKindSchema,
    price_minor_units: z.number().int().min(0).max(100_000_000).nullable().optional(),
    price_unit: propPriceUnitSchema.nullable().optional(),
    note: z.string().trim().max(200).nullable().optional(),
  })
  .strict()
  .transform((p) => {
    const hasPrice = p.kind === "addon" && p.price_minor_units !== null && p.price_minor_units !== undefined;
    return {
      name: p.name,
      kind: p.kind,
      price_minor_units: hasPrice ? (p.price_minor_units as number) : null,
      price_unit: hasPrice ? (p.price_unit ?? "per_booking") : null,
      note: blankToNull(p.note),
    };
  });
export type PropInput = z.infer<typeof propSchema>;

/** At most 40 props; the same name can't be listed twice. */
export const propsSchema = z
  .array(propSchema)
  .max(40)
  .refine((items) => new Set(items.map((p) => p.name.toLowerCase())).size === items.length, {
    message: "Each prop can only be listed once.",
  });

/** Free-text points a host or the team adds next to the tick boxes (extra amenities, house rules). */
export const customPointsSchema = z
  .array(z.string().trim().min(1).max(120))
  .max(20)
  .transform((items) => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

/**
 * What a production crew asks about. Max crew size is `capacity`. Every field can be cleared with
 * null; leaving it out leaves it as it is.
 */
export const listingDetailFields = {
  area_sqft: z.number().int().min(1).max(10_000_000).nullable().optional(),
  set_count: z.number().int().min(0).max(200).nullable().optional(),
  parking_spaces: z.number().int().min(0).max(1000).nullable().optional(),
  restroom_count: z.number().int().min(0).max(100).nullable().optional(),
  electricity: z.enum(["included", "extra", "not_available"]).nullable().optional(),
  permission_needed: z.boolean().nullable().optional(),
  permission_details: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : blankToNull(v))),
  custom_amenities: customPointsSchema.optional(),
  custom_rules: customPointsSchema.optional(),
  props: propsSchema.optional(),
};

export const locationStatusSchema = z.enum([
  "draft",
  "submitted",
  "under_review",
  "approved",
  "published",
  "rejected",
  "suspended",
  "archived",
]);

export const createLocationSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(5000).default(""),
    address_line1: z.string().max(200).nullable().optional(),
    address_line2: z.string().max(200).nullable().optional(),
    city: z.string().trim().min(1).max(120),
    region: z.string().max(120).nullable().optional(),
    country: z.string().trim().min(1).max(120),
    postal_code: z.string().max(20).nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    capacity: z.number().int().positive().nullable().optional(),
    timezone: ianaTimezoneSchema.optional(),
    instant_booking_enabled: z.boolean().optional(),
    area: areaSchema,
    /** Hide prices: bookings become requests the host answers with a price. */
    price_on_request: z.boolean().optional(),
    ...listingDetailFields,
    category_ids: z.array(uuid).max(20).default([]),
    amenity_ids: z.array(uuid).max(60).default([]),
    use_case_ids: z.array(uuid).max(10).default([]),
  })
  .strict();

export type CreateLocationInput = z.infer<typeof createLocationSchema>;

export const updateLocationSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(5000).optional(),
    address_line1: z.string().max(200).nullable().optional(),
    address_line2: z.string().max(200).nullable().optional(),
    city: z.string().trim().min(1).max(120).optional(),
    region: z.string().max(120).nullable().optional(),
    country: z.string().trim().min(1).max(120).optional(),
    postal_code: z.string().max(20).nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    capacity: z.number().int().positive().nullable().optional(),
    timezone: ianaTimezoneSchema.optional(),
    instant_booking_enabled: z.boolean().optional(),
    area: areaSchema,
    price_on_request: z.boolean().optional(),
    ...listingDetailFields,
    /** Team only (403 for hosts). Must be unused by any other listing. */
    listing_code: listingCodeSchema.optional(),
    category_ids: z.array(uuid).max(20).optional(),
    amenity_ids: z.array(uuid).max(60).optional(),
    use_case_ids: z.array(uuid).max(10).optional(),
    status: locationStatusSchema.optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: "Provide at least one field to update." });

export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;

export const locationIdParamSchema = z.object({ id: uuid });
export type LocationIdParam = z.infer<typeof locationIdParamSchema>;

export const listLocationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListLocationsQuery = z.infer<typeof listLocationsQuerySchema>;

export const adminListLocationsQuerySchema = listLocationsQuerySchema.extend({
  status: locationStatusSchema.optional(),
  host_id: uuid.optional(),
  search: z.string().trim().min(1).max(200).optional(),
});
export type AdminListLocationsQuery = z.infer<typeof adminListLocationsQuerySchema>;

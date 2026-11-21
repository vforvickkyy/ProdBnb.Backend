import { z } from "zod";

const uuid = z.string().uuid();

const commaSeparatedUuids = (max: number) =>
  z.preprocess(
    (val) => (typeof val === "string" ? val.split(",").map((s) => s.trim()).filter(Boolean) : val),
    z.array(uuid).max(max)
  );

export const sortSchema = z.enum(["newest", "relevant", "nearest", "price_asc", "price_desc"]);

/** "true" / "1" in a query string. Anything else (or leaving it out) means "don't filter". */
const flag = z
  .enum(["true", "1", "false", "0"])
  .transform((v) => v === "true" || v === "1");

export const searchLocationsQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(200).optional(),
    city: z.string().trim().min(1).max(120).optional(),
    region: z.string().trim().min(1).max(120).optional(),
    country: z.string().trim().min(1).max(120).optional(),
    category_ids: commaSeparatedUuids(20).optional(),
    amenity_ids: commaSeparatedUuids(20).optional(),
    use_case_ids: commaSeparatedUuids(20).optional(),
    capacity_min: z.coerce.number().int().positive().optional(),
    capacity_max: z.coerce.number().int().positive().optional(),
    /**
     * Budget, in minor units (paise for INR). Matches listings whose lowest active INR price -- the
     * card's "starting from" -- is inside the range. Listings without an INR price never match.
     */
    price_min: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
    price_max: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radius_km: z.coerce.number().positive().max(500).optional(),
    north: z.coerce.number().min(-90).max(90).optional(),
    south: z.coerce.number().min(-90).max(90).optional(),
    east: z.coerce.number().min(-180).max(180).optional(),
    west: z.coerce.number().min(-180).max(180).optional(),
    /** Details: at least this many parking spaces / square feet / restrooms / sets. */
    parking_min: z.coerce.number().int().min(0).max(1000).optional(),
    area_min: z.coerce.number().int().min(1).max(10_000_000).optional(),
    restrooms_min: z.coerce.number().int().min(0).max(100).optional(),
    sets_min: z.coerce.number().int().min(0).max(200).optional(),
    /** Only listings that say electricity is included in the price. */
    electricity_included: flag.optional(),
    /** Only listings that say no permission is needed. */
    no_permission: flag.optional(),
    /** Only listings that list props. */
    has_props: flag.optional(),
    sort: sortSchema.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict()
  .refine((data) => data.capacity_min === undefined || data.capacity_max === undefined || data.capacity_min <= data.capacity_max, {
    message: "capacity_min must be less than or equal to capacity_max.",
    path: ["capacity_min"],
  })
  .refine((data) => data.price_min === undefined || data.price_max === undefined || data.price_min <= data.price_max, {
    message: "price_min must be less than or equal to price_max.",
    path: ["price_min"],
  })
  .refine((data) => (data.lat === undefined) === (data.lng === undefined), {
    message: "lat and lng must be provided together.",
    path: ["lat"],
  })
  .refine((data) => data.radius_km === undefined || (data.lat !== undefined && data.lng !== undefined), {
    message: "radius_km requires lat and lng.",
    path: ["radius_km"],
  })
  .refine(
    (data) => {
      const box = [data.north, data.south, data.east, data.west];
      const provided = box.filter((v) => v !== undefined).length;
      return provided === 0 || provided === 4;
    },
    { message: "north, south, east, and west must all be provided together.", path: ["north"] }
  )
  .refine((data) => data.north === undefined || data.south === undefined || data.north > data.south, {
    message: "north must be greater than south.",
    path: ["north"],
  })
  .refine((data) => data.east === undefined || data.west === undefined || data.east > data.west, {
    message: "east must be greater than west (bounding boxes crossing the antimeridian are not supported).",
    path: ["east"],
  })
  .refine((data) => data.sort !== "nearest" || (data.lat !== undefined && data.lng !== undefined), {
    message: "sort=nearest requires lat and lng.",
    path: ["sort"],
  });

export type SearchLocationsQuery = z.infer<typeof searchLocationsQuerySchema>;

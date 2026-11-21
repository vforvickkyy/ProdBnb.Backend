import { describe, expect, it } from "vitest";
import { updateSettingsSchema } from "../src/modules/admin/admin.schema";
import {
  createLocationSchema,
  customPointsSchema,
  listingCodeSchema,
  propsSchema,
  updateLocationSchema,
} from "../src/modules/locations/locations.schema";
import { forViewer } from "../src/modules/locations/locations.service";
import { formatListingCode } from "../src/modules/platform/settings.service";
import { searchLocationsQuerySchema } from "../src/modules/search/search.schema";

const HOST = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";

describe("Listing IDs", () => {
  it("are written as prefix + number padded to the chosen digits", () => {
    expect(formatListingCode("HKLS", 2, 1)).toBe("HKLS01");
    expect(formatListingCode("HKLS", 2, 99)).toBe("HKLS99");
    expect(formatListingCode("HKLS", 2, 100)).toBe("HKLS100");
    expect(formatListingCode("HK", 4, 7)).toBe("HK0007");
  });

  it("are normalised to capitals and checked", () => {
    expect(listingCodeSchema.parse(" hkls07 ")).toBe("HKLS07");
    expect(listingCodeSchema.safeParse("A").success).toBe(false);
    expect(listingCodeSchema.safeParse("HKLS 07").success).toBe(false);
    expect(listingCodeSchema.safeParse("X".repeat(21)).success).toBe(false);
  });

  it("can be set in admin settings: prefix in capitals, 1 to 8 digits, next number from 1", () => {
    expect(updateSettingsSchema.parse({ listing_id_prefix: "hk", listing_id_digits: 3, listing_id_next: 50 })).toMatchObject({
      listing_id_prefix: "HK",
      listing_id_digits: 3,
      listing_id_next: 50,
    });
    expect(updateSettingsSchema.safeParse({ listing_id_prefix: "HK-LS" }).success).toBe(false);
    expect(updateSettingsSchema.safeParse({ listing_id_digits: 0 }).success).toBe(false);
    expect(updateSettingsSchema.safeParse({ listing_id_next: 0 }).success).toBe(false);
  });

  it("are hidden from everyone but the host and the team, even on a listing with a public address", () => {
    const listing = { host_id: HOST, listing_code: "HKLS07", show_exact_location: true, address_line1: "12 Marine Drive" };
    expect(forViewer(listing as never, { userId: null, isAdmin: false }).listing_code).toBeNull();
    expect(forViewer(listing as never, { userId: STRANGER, isAdmin: false }).listing_code).toBeNull();
    expect(forViewer(listing as never, { userId: HOST, isAdmin: false }).listing_code).toBe("HKLS07");
    expect(forViewer(listing as never, { userId: ADMIN, isAdmin: true }).listing_code).toBe("HKLS07");

    const hiddenAddress = { ...listing, show_exact_location: false, public_latitude: 1, public_longitude: 2 };
    const publicView = forViewer(hiddenAddress as never, { userId: null, isAdmin: false });
    expect(publicView.listing_code).toBeNull();
    expect(publicView.address_line1).toBeNull();
  });

  it("can only be changed through the update schema by name (the service refuses hosts)", () => {
    expect(updateLocationSchema.parse({ listing_code: "hkls12" }).listing_code).toBe("HKLS12");
  });
});

describe("Props", () => {
  it("keep their price only when they are add-ons, with a unit", () => {
    const [included, addon, askHost] = propsSchema.parse([
      { name: "Sofa set", kind: "included", price_minor_units: 5000 },
      { name: "Fog machine", kind: "addon", price_minor_units: 150000, price_unit: "per_hour" },
      { name: "Vintage car", kind: "addon", note: "  Ask the host for the price  " },
    ]);
    expect(included).toEqual({ name: "Sofa set", kind: "included", price_minor_units: null, price_unit: null, note: null });
    expect(addon).toMatchObject({ kind: "addon", price_minor_units: 150000, price_unit: "per_hour" });
    expect(askHost).toMatchObject({ price_minor_units: null, price_unit: null, note: "Ask the host for the price" });
  });

  it("default to a price per booking, and refuse repeats, blanks and more than 40", () => {
    expect(propsSchema.parse([{ name: "Lights", kind: "addon", price_minor_units: 100000 }])[0]?.price_unit).toBe("per_booking");
    expect(propsSchema.safeParse([{ name: "Sofa", kind: "included" }, { name: "SOFA", kind: "addon" }]).success).toBe(false);
    expect(propsSchema.safeParse([{ name: "  ", kind: "included" }]).success).toBe(false);
    const many = Array.from({ length: 41 }, (_, i) => ({ name: `Prop ${i}`, kind: "included" as const }));
    expect(propsSchema.safeParse(many).success).toBe(false);
  });
});

describe("Custom points", () => {
  it("are trimmed, de-duplicated without caring about capitals, and capped at 20", () => {
    expect(customPointsSchema.parse(["  Rooftop tank ", "rooftop TANK", "Terrace garden"])).toEqual(["Rooftop tank", "Terrace garden"]);
    expect(customPointsSchema.safeParse(Array.from({ length: 21 }, (_, i) => `Point ${i}`)).success).toBe(false);
    expect(customPointsSchema.safeParse(["x".repeat(121)]).success).toBe(false);
    expect(customPointsSchema.safeParse([""]).success).toBe(false);
  });
});

describe("Listing details in the listing API", () => {
  it("accept the new details on update, and let each one be cleared with null", () => {
    const parsed = updateLocationSchema.parse({
      area_sqft: 1800,
      set_count: 3,
      parking_spaces: 6,
      restroom_count: 2,
      electricity: "included",
      permission_needed: true,
      permission_details: "  Society NOC, 3 days  ",
      custom_amenities: ["Rooftop tank"],
      custom_rules: ["No shoes inside"],
      props: [{ name: "Sofa set", kind: "included" }],
    });
    expect(parsed.permission_details).toBe("Society NOC, 3 days");
    expect(updateLocationSchema.parse({ area_sqft: null, permission_needed: null, electricity: null })).toEqual({
      area_sqft: null,
      permission_needed: null,
      electricity: null,
    });
  });

  it("refuse impossible numbers and unknown electricity values", () => {
    expect(updateLocationSchema.safeParse({ parking_spaces: -1 }).success).toBe(false);
    expect(updateLocationSchema.safeParse({ set_count: 1.5 }).success).toBe(false);
    expect(updateLocationSchema.safeParse({ electricity: "sometimes" }).success).toBe(false);
  });

  it("are accepted when a listing is created, and many tick boxes can be chosen", () => {
    const parsed = createLocationSchema.parse({ title: "Loft", city: "Mumbai", country: "India", parking_spaces: 0, amenity_ids: [] });
    expect(parsed.parking_spaces).toBe(0);
    expect(parsed.props).toBeUndefined();
  });
});

describe("Search options", () => {
  it("take the new detail filters and price sorting", () => {
    const parsed = searchLocationsQuerySchema.parse({
      parking_min: "2",
      area_min: "1000",
      restrooms_min: "1",
      sets_min: "2",
      electricity_included: "true",
      no_permission: "1",
      has_props: "false",
      sort: "price_asc",
    });
    expect(parsed).toMatchObject({
      parking_min: 2,
      area_min: 1000,
      restrooms_min: 1,
      sets_min: 2,
      electricity_included: true,
      no_permission: true,
      has_props: false,
      sort: "price_asc",
    });
    expect(searchLocationsQuerySchema.parse({ sort: "price_desc" }).sort).toBe("price_desc");
    expect(searchLocationsQuerySchema.safeParse({ electricity_included: "maybe" }).success).toBe(false);
  });
});

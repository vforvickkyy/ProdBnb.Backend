import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

// Phase 29.14-B — the booking payload's location snapshot.
//
// `region` and `primary_media_url` join the one shared BOOKING_DETAIL_SELECT so the Booker booking
// list can show a photograph and a real place name without a request per row. These tests pin the
// two things most easily got wrong:
//
//   1. the cover must come from the GENERAL gallery only — a production-area photo at position 0 is
//      entirely normal and must never be served as the location's cover (the Phase 29.6 rule); and
//   2. the raw storage key must never leave the server.
//
// Media rows are seeded directly through `adminClient`, the same fixture shortcut
// `tests/locations.test.ts` uses for its media-mapping test: `authenticated` has no INSERT grant on
// `location_media` at all, and the real upload path is covered by tests/media.test.ts.

const app = createApp();

function authHeader(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${user.accessToken}` };
}

async function grantRole(user: TestUser, role: "host" | "booker"): Promise<void> {
  const res = await request(app).post("/v1/me/roles").set(authHeader(user)).send({ role });
  expect(res.status).toBe(201);
}

async function createLocation(owner: TestUser, title: string, region: string | null): Promise<string> {
  const res = await request(app)
    .post("/v1/locations")
    .set(authHeader(owner))
    .send({
      title,
      city: "Chail",
      ...(region === null ? {} : { region }),
      country: "India",
      timezone: "UTC",
    });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

// Phase 29.14-D: a host may no longer act on a booking nobody has paid for, so every test that
// exercises a host transition now settles the payment first. This seeds the row directly via
// adminClient (the same shortcut tests/payments-webhooks.test.ts uses) rather than driving real
// Cashfree checkout -- the transition rule is what is under test here, not the provider.
async function markBookingPaid(bookingId: string, amountMinorUnits = 20_000): Promise<void> {
  const { error } = await adminClient.from("payments").insert({
    booking_id: bookingId,
    provider: "cashfree",
    provider_order_id: `pb_test_${bookingId.replace(/-/g, "")}`,
    status: "success",
    amount_minor_units: amountMinorUnits,
    currency: "INR",
  });
  if (error) throw error;
}

async function publish(locationId: string): Promise<void> {
  const { error } = await adminClient.from("locations").update({ status: "published" }).eq("id", locationId);
  if (error) throw error;
}

async function addRule(locationId: string, owner: TestUser, day: string): Promise<void> {
  const res = await request(app)
    .post(`/v1/locations/${locationId}/availability/rules`)
    .set(authHeader(owner))
    .send({ day_of_week: day, start_time: "09:00", end_time: "18:00" });
  expect(res.status).toBe(201);
}

async function addHourlyPricing(locationId: string, owner: TestUser): Promise<void> {
  const res = await request(app)
    .post(`/v1/locations/${locationId}/pricing`)
    .set(authHeader(owner))
    .send({ booking_type: "hourly", amount_minor_units: 10_000 });
  expect(res.status).toBe(201);
}

/** A bookable, published location. `region` is `null` when the caller wants it absent. */
async function bookableLocation(owner: TestUser, title: string, region: string | null): Promise<string> {
  const locationId = await createLocation(owner, title, region);
  await addRule(locationId, owner, "monday");
  await addRule(locationId, owner, "tuesday");
  await addHourlyPricing(locationId, owner);
  await publish(locationId);
  return locationId;
}

async function makeSection(locationId: string, name = "Police Station"): Promise<string> {
  const { data, error } = await adminClient
    .from("location_sections")
    .insert({ location_id: locationId, name })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("no section");
  return data.id as string;
}

/** Seeds one media row. `sectionId === null` means the general gallery. */
async function seedMedia(
  locationId: string,
  storageKey: string,
  position: number,
  sectionId: string | null = null
): Promise<void> {
  const { error } = await adminClient.from("location_media").insert({
    location_id: locationId,
    media_type: "photo",
    storage_key: storageKey,
    position,
    section_id: sectionId,
  });
  if (error) throw error;
}

// 2026-10-05 is a Monday, 2026-10-06 a Tuesday.
async function book(booker: TestUser, locationId: string, date = "2026-10-05"): Promise<string> {
  const res = await request(app)
    .post("/v1/bookings")
    .set(authHeader(booker))
    .send({
      location_id: locationId,
      booking_type: "hourly",
      start_at: `${date}T10:00:00+00:00`,
      end_at: `${date}T12:00:00+00:00`,
    });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

interface BookingLocationBody {
  id: string;
  title: string;
  city: string;
  region: string | null;
  timezone: string;
  host_id: string;
  host: { first_name: string | null; last_name: string | null } | null;
  primary_media_url: string | null;
  storage_key?: unknown;
  location_media?: unknown;
}

async function detailLocation(user: TestUser, bookingId: string): Promise<BookingLocationBody> {
  const res = await request(app).get(`/v1/bookings/${bookingId}`).set(authHeader(user));
  expect(res.status).toBe(200);
  return res.body.data.location as BookingLocationBody;
}

describe("Phase 29.14-B: booking payload location region + cover media", () => {
  let host: TestUser;
  let booker: TestUser;

  beforeAll(async () => {
    host = await createTestUser();
    booker = await createTestUser();
    await grantRole(host, "host");
    await grantRole(booker, "booker");
  });

  afterAll(async () => {
    await deleteTestUser(host.id);
    await deleteTestUser(booker.id);
  });

  // ---- region -------------------------------------------------------------

  describe("region", () => {
    it("is returned on the booking's embedded location when the listing has one", async () => {
      const locationId = await bookableLocation(host, "Region Present Location", "Himachal Pradesh");
      const bookingId = await book(booker, locationId);

      const location = await detailLocation(booker, bookingId);
      expect(location.region).toBe("Himachal Pradesh");
    });

    it("is null — not absent, not empty string — when the listing has none", async () => {
      const locationId = await bookableLocation(host, "Region Absent Location", null);
      const bookingId = await book(booker, locationId);

      const location = await detailLocation(booker, bookingId);
      expect(location).toHaveProperty("region");
      expect(location.region).toBeNull();
    });
  });

  // ---- cover selection ----------------------------------------------------

  describe("primary_media_url", () => {
    it("is the general-gallery photo with the lowest position", async () => {
      const locationId = await bookableLocation(host, "Lowest Position Location", "Punjab");
      await seedMedia(locationId, "locations/lp/second.jpg", 5);
      await seedMedia(locationId, "locations/lp/cover.jpg", 1);
      await seedMedia(locationId, "locations/lp/third.jpg", 9);
      const bookingId = await book(booker, locationId);

      const location = await detailLocation(booker, bookingId);
      expect(location.primary_media_url).toContain("locations/lp/cover.jpg");
    });

    it("picks the lowest position regardless of the order the rows arrive in", async () => {
      // Seeded highest-position-first, so a mapper that simply took the first row would fail.
      const locationId = await bookableLocation(host, "Unordered Media Location", "Punjab");
      await seedMedia(locationId, "locations/um/z-last.jpg", 30);
      await seedMedia(locationId, "locations/um/m-middle.jpg", 20);
      await seedMedia(locationId, "locations/um/a-first.jpg", 10);
      const bookingId = await book(booker, locationId);

      const location = await detailLocation(booker, bookingId);
      expect(location.primary_media_url).toContain("locations/um/a-first.jpg");
    });

    it("NEVER selects a section photo as the location's cover", async () => {
      // Rigged so the answer cannot be a coincidence, exactly as the equivalent SEARCH test is:
      // the section photo sits at position 0 and the general one at position 5. Without the
      // `section_id === null` filter, "lowest position" picks the SECTION photo. Both galleries
      // start at 0 in normal use, so leaving them tied would let this pass by luck.
      const locationId = await bookableLocation(host, "Section Cover Location", "Punjab");
      const sectionId = await makeSection(locationId);
      await seedMedia(locationId, "locations/sc/section-photo.jpg", 0, sectionId);
      await seedMedia(locationId, "locations/sc/general-photo.jpg", 5, null);
      const bookingId = await book(booker, locationId);

      const location = await detailLocation(booker, bookingId);
      expect(location.primary_media_url).toContain("locations/sc/general-photo.jpg");
      expect(location.primary_media_url).not.toContain("section-photo");
    });

    it("is null when the location has only section photos", async () => {
      const locationId = await bookableLocation(host, "Sections Only Booking Location", "Punjab");
      const sectionId = await makeSection(locationId);
      await seedMedia(locationId, "locations/so/section-a.jpg", 0, sectionId);
      await seedMedia(locationId, "locations/so/section-b.jpg", 1, sectionId);
      const bookingId = await book(booker, locationId);

      const location = await detailLocation(booker, bookingId);
      expect(location.primary_media_url).toBeNull();
    });

    it("is null when the location has no media at all", async () => {
      const locationId = await bookableLocation(host, "No Media Location", "Punjab");
      const bookingId = await book(booker, locationId);

      const location = await detailLocation(booker, bookingId);
      expect(location.primary_media_url).toBeNull();
    });

    it("never exposes the raw storage key", async () => {
      const locationId = await bookableLocation(host, "Storage Key Location", "Punjab");
      await seedMedia(locationId, "locations/sk/cover.jpg", 0);
      const bookingId = await book(booker, locationId);

      const res = await request(app).get(`/v1/bookings/${bookingId}`).set(authHeader(booker));
      const location = res.body.data.location as BookingLocationBody;
      // The url contains the key by construction; what must not exist is a raw field carrying it,
      // or the embedded media array leaking through the old pass-through.
      expect(location.storage_key).toBeUndefined();
      expect(location.location_media).toBeUndefined();
    });

    it("carries no media from any OTHER location", async () => {
      const mine = await bookableLocation(host, "Mine Location", "Punjab");
      const theirs = await bookableLocation(host, "Theirs Location", "Punjab");
      await seedMedia(mine, "locations/mine/cover.jpg", 0);
      await seedMedia(theirs, "locations/theirs/cover.jpg", 0);
      const bookingId = await book(booker, mine);

      const location = await detailLocation(booker, bookingId);
      expect(location.primary_media_url).toContain("locations/mine/cover.jpg");
      expect(location.primary_media_url).not.toContain("theirs");
      expect(location.id).toBe(mine);
    });
  });

  // ---- the shared select reaches every endpoint ---------------------------

  describe("every booking endpoint carrying the shared shape", () => {
    it("returns region and cover on create, list, detail and cancel alike", async () => {
      const locationId = await bookableLocation(host, "All Endpoints Location", "Himachal Pradesh");
      await seedMedia(locationId, "locations/ae/cover.jpg", 0);

      // create
      const created = await request(app)
        .post("/v1/bookings")
        .set(authHeader(booker))
        .send({
          location_id: locationId,
          booking_type: "hourly",
          start_at: "2026-10-06T10:00:00+00:00",
          end_at: "2026-10-06T12:00:00+00:00",
        });
      expect(created.status).toBe(201);
      expect(created.body.data.location.region).toBe("Himachal Pradesh");
      expect(created.body.data.location.primary_media_url).toContain("locations/ae/cover.jpg");
      const bookingId = created.body.data.id as string;

      // list
      const list = await request(app).get("/v1/bookings").set(authHeader(booker)).query({ booker_id: booker.id });
      expect(list.status).toBe(200);
      const listed = list.body.data.find((b: { id: string }) => b.id === bookingId);
      expect(listed.location.region).toBe("Himachal Pradesh");
      expect(listed.location.primary_media_url).toContain("locations/ae/cover.jpg");

      // detail
      const detail = await detailLocation(booker, bookingId);
      expect(detail.region).toBe("Himachal Pradesh");
      expect(detail.primary_media_url).toContain("locations/ae/cover.jpg");

      // cancel — a transition response, which uses the same select
      const cancelled = await request(app).post(`/v1/bookings/${bookingId}/cancel`).set(authHeader(booker)).send({});
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.data.status).toBe("cancelled");
      expect(cancelled.body.data.location.region).toBe("Himachal Pradesh");
      expect(cancelled.body.data.location.primary_media_url).toContain("locations/ae/cover.jpg");
    });

    it("returns region and cover on the host's confirm response too", async () => {
      const locationId = await bookableLocation(host, "Confirm Endpoint Location", "Goa");
      await seedMedia(locationId, "locations/ce/cover.jpg", 0);
      const bookingId = await book(booker, locationId, "2026-10-12");
      await markBookingPaid(bookingId);

      const confirmed = await request(app).post(`/v1/bookings/${bookingId}/confirm`).set(authHeader(host)).send({});
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.data.status).toBe("confirmed");
      expect(confirmed.body.data.location.region).toBe("Goa");
      expect(confirmed.body.data.location.primary_media_url).toContain("locations/ce/cover.jpg");
    });
  });

  // ---- nothing else moved -------------------------------------------------

  describe("pre-existing response fields", () => {
    it("are all still present and unchanged alongside the two additions", async () => {
      const locationId = await bookableLocation(host, "Unchanged Fields Location", "Kerala");
      await seedMedia(locationId, "locations/uf/cover.jpg", 0);
      const bookingId = await book(booker, locationId, "2026-10-13");

      const res = await request(app).get(`/v1/bookings/${bookingId}`).set(authHeader(booker));
      expect(res.status).toBe(200);
      const body = res.body.data;

      // The embedded location keeps every field it had before 29.14-B.
      expect(body.location.id).toBe(locationId);
      expect(body.location.title).toBe("Unchanged Fields Location");
      expect(body.location.city).toBe("Chail");
      expect(body.location.timezone).toBe("UTC");
      expect(body.location.host_id).toBe(host.id);
      expect(body.location).toHaveProperty("host");

      // And the booking's own fields are untouched.
      expect(body.booking_type).toBe("hourly");
      expect(body.status).toBe("requested");
      expect(body.booker_id).toBe(booker.id);
      expect(body.pricing).toMatchObject({ currency: "INR", total_amount_minor_units: 20_000 });
      expect(body).toHaveProperty("payments");
      expect(body).toHaveProperty("created_at");
      expect(body).toHaveProperty("updated_at");
      expect(body.cancelled_at).toBeNull();
      expect(body.cancelled_by).toBeNull();
      expect(body.cancellation_reason).toBeNull();

      // The location snapshot is exactly these keys — no raw media leaked in.
      expect(Object.keys(body.location).sort()).toEqual(
        ["city", "host", "host_id", "id", "primary_media_url", "region", "timezone", "title"].sort()
      );
    });
  });
});

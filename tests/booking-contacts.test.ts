import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

const app = createApp();
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.accessToken}` });

describe("contacts after booking", () => {
  let host: TestUser;
  let booker: TestUser;
  let other: TestUser;
  let locationId: string;
  let bookingId: string;

  beforeAll(async () => {
    [host, booker, other] = await Promise.all([createTestUser(), createTestUser(), createTestUser()]);
    expect((await request(app).post("/v1/me/roles").set(auth(host)).send({ role: "host" })).status).toBe(201);
    expect((await request(app).post("/v1/me/roles").set(auth(booker)).send({ role: "booker" })).status).toBe(201);
    await adminClient.from("profiles").update({ phone: "+91 98765 43210", first_name: "Bina" }).eq("id", booker.id);
    await adminClient.from("profiles").update({ phone: "+91 91234 56789", first_name: "Hari" }).eq("id", host.id);
    const created = await request(app)
      .post("/v1/locations")
      .set(auth(host))
      .send({ title: "Contact studio", city: "Pune", country: "India", address_line1: "12 Lane 5, Koregaon Park", postal_code: "411001", latitude: 18.53, longitude: 73.89, timezone: "Asia/Kolkata" });
    locationId = created.body.data.id;
    expect((await request(app).post(`/v1/locations/${locationId}/availability/rules`).set(auth(host)).send({ day_of_week: "monday", start_time: "09:00", end_time: "18:00" })).status).toBe(201);
    expect((await request(app).post(`/v1/locations/${locationId}/pricing`).set(auth(host)).send({ booking_type: "hourly", amount_minor_units: 100_000 })).status).toBe(201);
    await adminClient.from("locations").update({ status: "published" }).eq("id", locationId);
    const booked = await request(app)
      .post("/v1/bookings")
      .set(auth(booker))
      .send({ location_id: locationId, booking_type: "hourly", start_at: "2027-03-01T10:00:00+05:30", end_at: "2027-03-01T12:00:00+05:30" });
    expect(booked.status).toBe(201);
    bookingId = booked.body.data.id;
  });

  afterAll(async () => {
    await adminClient.from("payments").delete().eq("booking_id", bookingId);
    await adminClient.from("bookings").delete().eq("id", bookingId);
    await adminClient.from("locations").delete().eq("id", locationId);
    for (const u of [host, booker, other]) await deleteTestUser(u.id);
  });

  it("lets only the owner keep on-site contact and arrival notes", async () => {
    const body = { onsite_contact_name: "Ramesh (caretaker)", onsite_contact_phone: "+91 90000 11111", arrival_notes: "Gate 2, ring the bell." };
    expect((await request(app).put(`/v1/locations/${locationId}/private-details`).set(auth(other)).send(body)).status).toBe(403);
    const saved = await request(app).put(`/v1/locations/${locationId}/private-details`).set(auth(host)).send(body);
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject(body);
    expect((await request(app).get(`/v1/locations/${locationId}/private-details`).set(auth(host))).body.data.arrival_notes).toBe("Gate 2, ring the bell.");
    // Never on the public listing.
    const pub = await request(app).get(`/v1/locations/${locationId}`);
    expect(JSON.stringify(pub.body)).not.toContain("caretaker");
  });

  it("shares nothing before payment", async () => {
    const asHost = await request(app).get(`/v1/bookings/${bookingId}`).set(auth(host));
    expect(asHost.body.data.booker_contact).toBeUndefined();
    const asBooker = await request(app).get(`/v1/bookings/${bookingId}`).set(auth(booker));
    expect(asBooker.body.data.contact).toBeUndefined();
  });

  it("shows the host the booker's phone once paid, and the booker the full contact once confirmed", async () => {
    await adminClient.from("payments").insert({ booking_id: bookingId, provider: "cashfree", provider_order_id: `pb_c_${bookingId.replace(/-/g, "")}`, status: "success", amount_minor_units: 200_000, currency: "INR" });

    const asHost = await request(app).get(`/v1/bookings/${bookingId}`).set(auth(host));
    expect(asHost.body.data.booker_contact).toEqual({ phone: "+91 98765 43210", email: booker.email });

    // Paid but only requested: the booker waits for the host to accept.
    expect((await request(app).get(`/v1/bookings/${bookingId}`).set(auth(booker))).body.data.contact).toBeUndefined();

    expect((await request(app).post(`/v1/bookings/${bookingId}/confirm`).set(auth(host))).status).toBe(200);
    const asBooker = await request(app).get(`/v1/bookings/${bookingId}`).set(auth(booker));
    expect(asBooker.body.data.contact).toMatchObject({
      address: { address_line1: "12 Lane 5, Koregaon Park", postal_code: "411001", city: "Pune", latitude: 18.53 },
      host: { first_name: "Hari", phone: "+91 91234 56789", email: host.email },
      onsite: { name: "Ramesh (caretaker)", phone: "+91 90000 11111" },
      arrival_notes: "Gate 2, ring the bell.",
    });
    expect(asBooker.body.data.booker_contact).toBeUndefined();
    expect((await request(app).get(`/v1/bookings/${bookingId}`).set(auth(other))).status).toBe(404);
  });
});

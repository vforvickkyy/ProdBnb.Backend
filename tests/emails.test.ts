import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { setEmailActionKeyForTesting, signEmailAction } from "../src/modules/email/actions";
import { processEmailOutbox, queueEmail, setEmailSenderForTesting } from "../src/modules/email/outbox.service";
import { buildEmail } from "../src/modules/email/templates";
import type { OutgoingEmail } from "../src/modules/outreach/email";
import { adminClient, createTestUser, deleteTestUser, grantAdminRole, TestUser } from "./setup";

/** Transactional emails: rendering, the outbox, and accepting a booking from its email. */

const app = createApp();
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.accessToken}` });
const sent: OutgoingEmail[] = [];
let failNext = false;

describe("transactional emails", () => {
  let host: TestUser;
  let booker: TestUser;
  let admin: TestUser;
  let locationId: string;
  let day = 3;

  async function newBooking(paid = true): Promise<string> {
    day += 1;
    const date = `2027-03-${String(day).padStart(2, "0")}`;
    const { data, error } = await adminClient
      .from("bookings")
      .insert({
        location_id: locationId,
        booker_id: booker.id,
        booking_type: "hourly",
        start_at: `${date}T04:30:00Z`,
        end_at: `${date}T08:30:00Z`,
        status: "requested",
        base_amount_minor_units: 800000,
        platform_fee_minor_units: 40000,
        total_amount_minor_units: 840000,
        currency: "INR",
        crew_size: 12,
        shoot_type: "Music video",
        production_name: "Blue Door Films",
        shoot_notes: "Need the terrace from 10.",
      })
      .select("id")
      .single();
    if (error) throw error;
    if (paid) {
      const { error: payError } = await adminClient.from("payments").insert({
        booking_id: data.id,
        provider: "cashfree",
        provider_order_id: `pb_email_${(data.id as string).replace(/-/g, "")}`,
        status: "success",
        amount_minor_units: 840000,
        currency: "INR",
      });
      if (payError) throw payError;
    }
    return data.id as string;
  }

  beforeAll(async () => {
    setEmailActionKeyForTesting("test-signing-secret-that-is-long-enough-123456");
    setEmailSenderForTesting(async (m) => {
      if (failNext) {
        failNext = false;
        throw new Error("Provider is down");
      }
      sent.push(m);
      return `msg_${sent.length}`;
    });
    [host, booker, admin] = await Promise.all([createTestUser(), createTestUser(), createTestUser()]);
    await grantAdminRole(admin.id);
    await adminClient.from("profiles").update({ first_name: "Hema", last_name: "Host", phone: "+91 90000 00001" }).eq("id", host.id);
    await adminClient.from("profiles").update({ first_name: "Arjun", last_name: "Rao", phone: "+91 90000 00002" }).eq("id", booker.id);
    const { data, error } = await adminClient
      .from("locations")
      .insert({ host_id: host.id, title: "Sunlit Terrace", city: "Pune", country: "IN", area: "Koregaon Park", address_line1: "12 Lane 5", latitude: 18.53, longitude: 73.89, status: "submitted" })
      .select("id")
      .single();
    if (error) throw error;
    locationId = data.id as string;
  });

  afterAll(async () => {
    setEmailSenderForTesting(null);
    setEmailActionKeyForTesting(null);
    await adminClient.from("email_outbox").delete().in("user_id", [host.id, booker.id]);
    await adminClient.from("payments").delete().in("booking_id", (await adminClient.from("bookings").select("id").eq("location_id", locationId)).data!.map((b) => b.id));
    await adminClient.from("bookings").delete().eq("location_id", locationId);
    await adminClient.from("locations").delete().eq("id", locationId);
    await Promise.all([host, booker, admin].map((u) => deleteTestUser(u.id)));
  });

  it("the host's request email has the shoot details and Accept / Decline links; never a street address", async () => {
    const id = await newBooking();
    const email = await buildEmail("host_booking_request", { bookingId: id }, host.id);
    expect(email).not.toBeNull();
    expect(email!.subject).toContain("Sunlit Terrace");
    expect(email!.html).toContain("Arjun Rao");
    expect(email!.html).toContain("Blue Door Films");
    expect(email!.html).toContain("Music video");
    expect(email!.html).toContain("₹8,000");
    expect(email!.html).toMatch(/\/email-action\/[\w-]+\.[\w-]+/);
    expect(email!.html).not.toContain("12 Lane 5");
    expect(email!.text).toContain("Accept:");
  });

  it("the confirmed email adds the address and host phone; skipped while not confirmed", async () => {
    const id = await newBooking();
    expect(await buildEmail("booking_confirmed", { bookingId: id }, booker.id)).toBeNull();
    await adminClient.from("bookings").update({ status: "confirmed" }).eq("id", id);
    const email = await buildEmail("booking_confirmed", { bookingId: id }, booker.id);
    expect(email!.html).toContain("12 Lane 5");
    expect(email!.html).toContain("+91 90000 00001");
  });

  it("queues once per event, sends straight away, and retries after a failure", async () => {
    const id = await newBooking();
    const before = sent.length;
    await queueEmail({ userId: booker.id, template: "payment_failed", key: `test:${id}:failed`, data: { bookingId: id } });
    await queueEmail({ userId: booker.id, template: "payment_failed", key: `test:${id}:failed`, data: { bookingId: id } });
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)!.to).toBe(booker.email);

    failNext = true;
    await queueEmail({ userId: booker.id, template: "payment_failed", key: `test:${id}:retry`, data: { bookingId: id } });
    const { data: row } = await adminClient.from("email_outbox").select("status, attempts, last_error").eq("idempotency_key", `test:${id}:retry`).single();
    expect(row).toMatchObject({ status: "queued", attempts: 1 });
    expect(row!.last_error).toContain("Provider is down");
    await adminClient.from("email_outbox").update({ send_after: new Date().toISOString() }).eq("idempotency_key", `test:${id}:retry`);
    await processEmailOutbox(Date.now() + 5000);
    const { data: after } = await adminClient.from("email_outbox").select("status, attempts, subject").eq("idempotency_key", `test:${id}:retry`).single();
    expect(after).toMatchObject({ status: "sent", attempts: 2 });
    expect(after!.subject).toContain("didn't go through");
  });

  it("the host accepts from the email: confirm page first, then the booking is confirmed and the booker emailed", async () => {
    const id = await newBooking();
    const token = await signEmailAction(id, host.id, "accept");
    const page = await request(app).get(`/v1/email-actions/${token}`);
    expect(page.status).toBe(200);
    expect(page.body.data).toMatchObject({ action: "accept", actionable: true, booker_name: "Arjun Rao", place: "Sunlit Terrace" });
    // Opening the page changed nothing (mail scanners open links).
    expect((await adminClient.from("bookings").select("status").eq("id", id).single()).data!.status).toBe("requested");

    const done = await request(app).post(`/v1/email-actions/${token}`).send({});
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe("confirmed");
    expect(sent.some((m) => m.to === booker.email && m.subject.startsWith("Confirmed:"))).toBe(true);

    const again = await request(app).post(`/v1/email-actions/${token}`).send({});
    expect(again.status).toBe(400);
    expect((await request(app).get(`/v1/email-actions/${token}`)).body.data.actionable).toBe(false);
  });

  it("decline works with a reason; forged, expired or other hosts' links are refused", async () => {
    const id = await newBooking();
    const decline = await signEmailAction(id, host.id, "decline");
    const res = await request(app).post(`/v1/email-actions/${decline}`).send({ reason: "Terrace under repair that day" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("rejected");

    const other = await newBooking();
    const forged = (await signEmailAction(other, host.id, "accept")).replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect((await request(app).get(`/v1/email-actions/${forged}`)).status).toBe(400);
    const expired = await signEmailAction(other, host.id, "accept", Date.now() - 8 * 24 * 3600_000);
    expect((await request(app).get(`/v1/email-actions/${expired}`)).status).toBe(400);
    const wrongHost = await signEmailAction(other, booker.id, "accept");
    expect((await request(app).post(`/v1/email-actions/${wrongHost}`).send({})).status).toBe(404);
  });

  it("approving a listing emails the host, and the admin email log lists it", async () => {
    const res = await request(app).post(`/v1/admin/locations/${locationId}/approve`).set(auth(admin)).send({});
    expect([200, 201]).toContain(res.status);
    expect(sent.some((m) => m.to === host.email && m.subject.includes("is live"))).toBe(true);

    const log = await request(app).get(`/v1/admin/emails?template=listing_approved`).set(auth(admin));
    expect(log.status).toBe(200);
    expect(log.body.data.some((r: { to_email: string; status: string }) => r.to_email === host.email && r.status === "sent")).toBe(true);
    const summary = await request(app).get(`/v1/admin/emails/summary`).set(auth(admin));
    expect(summary.body.data.sent).toBeGreaterThan(0);
  });
});

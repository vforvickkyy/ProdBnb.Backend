import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const SITE = "https://site.test/api/revalidate";
vi.mock("../src/config/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/config/env")>();
  return { ...mod, env: { ...mod.env, WEBSITE_REVALIDATE_URL: "https://site.test/api/revalidate", WEBSITE_REVALIDATE_SECRET: "x".repeat(32) } };
});

import { createApp } from "../src/app";
import { adminClient, createTestUser, deleteTestUser, TestUser } from "./setup";

const app = createApp();
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.accessToken}` });

describe("a listing change refreshes its website page", () => {
  let host: TestUser;
  let other: TestUser;
  let locationId: string;
  const calls: { body: unknown; authorization: string | null }[] = [];
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === SITE) {
        calls.push({ body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get("authorization") });
        return new Response("{}", { status: 200 });
      }
      return realFetch(input, init);
    });
    [host, other] = await Promise.all([createTestUser(), createTestUser()]);
    expect((await request(app).post("/v1/me/roles").set(auth(host)).send({ role: "host" })).status).toBe(201);
    locationId = (await request(app).post("/v1/locations").set(auth(host)).send({ title: "Refresh me", city: "Pune", country: "India" })).body.data.id;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await adminClient.from("locations").delete().eq("id", locationId);
    for (const u of [host, other]) await deleteTestUser(u.id);
  });

  it("asks the website to refresh after a successful edit, with the shared secret", async () => {
    calls.length = 0;
    expect((await request(app).patch(`/v1/locations/${locationId}`).set(auth(host)).send({ price_on_request: true })).status).toBe(200);
    expect(calls).toEqual([{ body: { location_ids: [locationId] }, authorization: `Bearer ${"x".repeat(32)}` }]);
  });

  it("also for changes under the listing (prices, timings...)", async () => {
    calls.length = 0;
    expect((await request(app).post(`/v1/locations/${locationId}/pricing`).set(auth(host)).send({ booking_type: "day", amount_minor_units: 500000 })).status).toBe(201);
    expect(calls).toHaveLength(1);
  });

  it("not for reads, and not for refused edits", async () => {
    calls.length = 0;
    await request(app).get(`/v1/locations/${locationId}`).set(auth(host));
    // A draft is invisible to anyone else: 404.
    expect((await request(app).patch(`/v1/locations/${locationId}`).set(auth(other)).send({ title: "Nope" })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Maps server key comes from Vault in real life; here it is whatever the test says.
const keyState = vi.hoisted(() => ({ key: "AIzaSyServerKey0123456789abcdefghijklmn" as string | null }));
vi.mock("../src/modules/site/integrations.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/site/integrations.service")>();
  return { ...actual, getMapsServerKey: vi.fn(async () => keyState.key) };
});

import { createApp } from "../src/app";

const app = createApp();

type Call = { url: URL; method: string; headers: Record<string, string>; body: unknown };

/** Answers Google Places calls from fixtures; records what was asked. */
function fakeGoogle(handler: (call: Call) => Response) {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "places.googleapis.com") return realFetch(input, init);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("GET /v1/places/autocomplete", () => {
  beforeEach(() => {
    keyState.key = "AIzaSyServerKey0123456789abcdefghijklmn";
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns Google's India suggestions as main + secondary text", async () => {
    const calls = fakeGoogle(() =>
      json(200, {
        suggestions: [
          { placePrediction: { placeId: "ChIJbandra", text: { text: "Bandra West, Mumbai" }, structuredFormat: { mainText: { text: "Bandra West" }, secondaryText: { text: "Mumbai, Maharashtra, India" } } } },
          { queryPrediction: { text: { text: "bandra cafes" } } },
          { placePrediction: { placeId: "ChIJbandraE", text: { text: "Bandra East" } } },
        ],
      })
    );
    const res = await request(app).get("/v1/places/autocomplete").query({ q: "Bandra", session: "3f2b8c1e-aaaa-bbbb-cccc-0123456789ab" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { id: "ChIJbandra", main: "Bandra West", secondary: "Mumbai, Maharashtra, India" },
      { id: "ChIJbandraE", main: "Bandra East", secondary: "" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/v1/places:autocomplete");
    expect(calls[0]!.headers["X-Goog-Api-Key"]).toBe("AIzaSyServerKey0123456789abcdefghijklmn");
    expect(calls[0]!.body).toMatchObject({ input: "Bandra", includedRegionCodes: ["in"], sessionToken: "3f2b8c1e-aaaa-bbbb-cccc-0123456789ab" });
  });

  it("never sends the key back to the app", async () => {
    fakeGoogle(() => json(200, { suggestions: [] }));
    const res = await request(app).get("/v1/places/autocomplete").query({ q: "Goa" });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("AIzaSy");
  });

  it("says place search isn't set up (503) when there is no server key", async () => {
    keyState.key = null;
    const calls = fakeGoogle(() => json(200, {}));
    const res = await request(app).get("/v1/places/autocomplete").query({ q: "Bandra" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(res.body.error.details).toMatchObject({ reason: "places_not_configured" });
    expect(calls).toHaveLength(0);
  });

  it("turns a Google refusal (e.g. API not enabled on the key) into a 503, not a crash", async () => {
    fakeGoogle(() => json(403, { error: { status: "PERMISSION_DENIED", message: "Places API (New) has not been used" } }));
    const res = await request(app).get("/v1/places/autocomplete").query({ q: "Bandra" });
    expect(res.status).toBe(503);
    expect(res.body.error.details).toMatchObject({ reason: "places_failed", google_status: "PERMISSION_DENIED" });
  });

  it("rejects too-short queries and odd session tokens", async () => {
    fakeGoogle(() => json(200, { suggestions: [] }));
    expect((await request(app).get("/v1/places/autocomplete").query({ q: "B" })).status).toBe(400);
    expect((await request(app).get("/v1/places/autocomplete").query({ q: "Bandra", session: "a b<c>" })).status).toBe(400);
  });
});

describe("GET /v1/places/:placeId", () => {
  beforeEach(() => {
    keyState.key = "AIzaSyServerKey0123456789abcdefghijklmn";
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns the point and the viewport box the search uses", async () => {
    const calls = fakeGoogle(() =>
      json(200, {
        id: "ChIJbandra",
        displayName: { text: "Bandra West" },
        formattedAddress: "Bandra West, Mumbai, Maharashtra, India",
        location: { latitude: 19.0596, longitude: 72.8295 },
        viewport: { low: { latitude: 19.04, longitude: 72.81 }, high: { latitude: 19.08, longitude: 72.85 } },
      })
    );
    const res = await request(app).get("/v1/places/ChIJbandra").query({ session: "3f2b8c1e-aaaa-bbbb-cccc-0123456789ab" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: "ChIJbandra",
      name: "Bandra West",
      address: "Bandra West, Mumbai, Maharashtra, India",
      lat: 19.0596,
      lng: 72.8295,
      viewport: { north: 19.08, south: 19.04, east: 72.85, west: 72.81 },
    });
    expect(calls[0]!.url.pathname).toBe("/v1/places/ChIJbandra");
    expect(calls[0]!.url.searchParams.get("sessionToken")).toBe("3f2b8c1e-aaaa-bbbb-cccc-0123456789ab");
    expect(calls[0]!.headers["X-Goog-FieldMask"]).toBe("id,displayName,formattedAddress,location,viewport");
  });

  it("gives a bare point when Google has no viewport", async () => {
    fakeGoogle(() => json(200, { id: "ChIJpoint", displayName: { text: "Gateway of India" }, location: { latitude: 18.922, longitude: 72.8347 } }));
    const res = await request(app).get("/v1/places/ChIJpoint");
    expect(res.status).toBe(200);
    expect(res.body.data.viewport).toBeNull();
    expect(res.body.data.address).toBeNull();
  });

  it("404s an unknown place", async () => {
    fakeGoogle(() => json(404, { error: { status: "NOT_FOUND" } }));
    expect((await request(app).get("/v1/places/ChIJnothing")).status).toBe(404);
  });
});

import { describe, expect, it } from "vitest";
import { androidChannelFor } from "../src/modules/notifications/providers/FCMProvider";

describe("androidChannelFor", () => {
  it("maps push categories to the Android app's channels", () => {
    expect(androidChannelFor("PRODBNB_MESSAGE")).toBe("messages");
    expect(androidChannelFor("PRODBNB_BOOKING")).toBe("bookings");
    expect(androidChannelFor(null)).toBe("general");
    expect(androidChannelFor("ANYTHING")).toBe("general");
  });
});

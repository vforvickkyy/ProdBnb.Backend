import { describe, expect, it } from "vitest";
import { pushPresentationFor } from "../src/modules/notifications/notification.service";

describe("how a push is presented on a phone", () => {
  it("stacks messages per conversation and offers Reply", () => {
    expect(pushPresentationFor({ type: "new_message", entity_type: "conversation", entity_id: "c1" })).toEqual({
      threadId: "c1",
      category: "PRODBNB_MESSAGE",
      interruptionLevel: null,
    });
  });

  it("stacks booking updates per booking and offers View booking; a new request is time-sensitive", () => {
    expect(pushPresentationFor({ type: "booking_confirmed", entity_type: "booking", entity_id: "b1" })).toEqual({
      threadId: "booking-b1",
      category: "PRODBNB_BOOKING",
      interruptionLevel: null,
    });
    expect(pushPresentationFor({ type: "booking_request_received", entity_type: "booking", entity_id: "b1" }).interruptionLevel).toBe("time-sensitive");
  });

  it("keeps announcements plain", () => {
    expect(pushPresentationFor({ type: "announcement", entity_type: "announcement", entity_id: "a1" })).toEqual({
      threadId: null,
      category: null,
      interruptionLevel: null,
    });
  });
});

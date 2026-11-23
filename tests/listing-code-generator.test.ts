import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient } from "./setup";

/**
 * The database's listing ID generator, past the padding width. lpad() truncates in PostgreSQL, so
 * number 100 with 2 digits once came out as "10" (taken), and creating a listing hung forever.
 */
describe("next_listing_code past the padding width", () => {
  let saved: { listing_id_prefix: string; listing_id_digits: number; listing_id_next: number };

  beforeAll(async () => {
    const { data, error } = await adminClient
      .from("platform_settings")
      .select("listing_id_prefix, listing_id_digits, listing_id_next")
      .eq("singleton", true)
      .single();
    if (error) throw error;
    saved = data as typeof saved;
  });

  afterAll(async () => {
    await adminClient.from("platform_settings").update(saved).eq("singleton", true);
  });

  it("pads short numbers and keeps long ones whole", async () => {
    await adminClient.from("platform_settings").update({ listing_id_prefix: "ZQ", listing_id_digits: 2, listing_id_next: 7 }).eq("singleton", true);
    expect((await adminClient.rpc("next_listing_code")).data).toBe("ZQ07");

    await adminClient.from("platform_settings").update({ listing_id_next: 100 }).eq("singleton", true);
    const { data, error } = await adminClient.rpc("next_listing_code");
    expect(error).toBeNull();
    expect(data).toBe("ZQ100");
    expect((await adminClient.rpc("next_listing_code")).data).toBe("ZQ101");
  });
});

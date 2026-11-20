import { describe, expect, it } from "vitest";
import { describePhoneLogin, PHONE_LOGIN_SETUP } from "../src/modules/admin/integrations.service";

describe("Phone login status (admin System page)", () => {
  it("is on when Supabase has the phone provider enabled", () => {
    const result = describePhoneLogin({ external: { email: true, phone: true }, sms_provider: "twilio_verify" });
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("twilio_verify");
  });

  it("is off, with the setup steps, when it isn't", () => {
    const result = describePhoneLogin({ external: { email: true, phone: false }, sms_provider: "twilio" });
    expect(result).toEqual({ status: "disabled", detail: PHONE_LOGIN_SETUP });
    expect(describePhoneLogin({}).status).toBe("disabled");
  });
});

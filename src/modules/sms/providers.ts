/**
 * SMS provider connectors. Each one does two things only: send one text, and read that provider's
 * delivery reports. Everything else (wording, DLT ids, the outbox, retries, who gets what) is ours
 * and the same for every provider, so switching provider is a setting in the admin, not a code
 * change. Adding a provider = one more entry here.
 *
 * Every text is sent as full wording plus its DLT template id: that is what Indian operators check,
 * whoever delivers it.
 */

export const SMS_PROVIDERS = ["msg91", "twilio", "twofactor", "gupshup"] as const;
export type SmsProviderId = (typeof SMS_PROVIDERS)[number];

export interface ProviderField {
  key: string;
  label: string;
  /** Secret fields go to Vault and are never shown again. */
  secret: boolean;
  required: boolean;
  placeholder?: string;
  help?: string;
}

export interface OutgoingSms {
  /** E.164, e.g. +919876543210. */
  to: string;
  body: string;
  senderId: string | null;
  dltEntityId: string | null;
  dltTemplateId: string | null;
  providerTemplateId: string | null;
  category: "otp" | "transactional" | "service";
  /** Where the provider should send this text's delivery report (when it takes one per text). */
  reportUrl: string | null;
}

export interface DeliveryReport {
  messageId: string;
  status: "delivered" | "failed";
  error?: string;
}

export interface ProviderDef {
  id: SmsProviderId;
  name: string;
  website: string;
  fields: ProviderField[];
  /** Where the delivery-report address goes in the provider's dashboard, if it isn't sent per text. */
  reportSetup: string;
  send(msg: OutgoingSms, config: Record<string, string>, secret: Record<string, string>): Promise<string>;
  parseReports(payload: Record<string, unknown>): DeliveryReport[];
}

const TIMEOUT_MS = 10_000;

let fetcher: typeof fetch = (...args) => fetch(...args);
/** Tests only: answer provider calls without the network. */
export function setSmsFetchForTesting(fn: typeof fetch | null): void {
  fetcher = fn ?? ((...args) => fetch(...args));
}

async function call(url: string, init: RequestInit): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new Error("The SMS provider didn't answer in 10 seconds.");
    throw new Error(`Couldn't reach the SMS provider: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

function json(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Error text from a provider, short and without anything that looks like a key. */
function providerError(name: string, status: number, text: string): Error {
  const clean = text.replace(/[A-Za-z0-9_-]{24,}/g, "…").replace(/\s+/g, " ").slice(0, 240);
  return new Error(`${name} refused the text (HTTP ${status}): ${clean || "no details"}`);
}

const digitsOnly = (e164: string) => e164.replace(/^\+/, "");
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

// -- MSG91 ----------------------------------------------------------------------------------------

const msg91: ProviderDef = {
  id: "msg91",
  name: "MSG91",
  website: "https://msg91.com",
  fields: [
    { key: "auth_key", label: "Auth key", secret: true, required: true, help: "MSG91 dashboard -> top-right menu -> Authkey." },
    { key: "route", label: "Route", secret: false, required: false, placeholder: "4", help: "4 = transactional (default)." },
  ],
  reportSetup: "MSG91 dashboard -> Settings (or SMS -> Webhook) -> delivery report webhook: paste the address below.",
  async send(msg, config, secret) {
    const { status, text } = await call("https://api.msg91.com/api/v2/sendsms", {
      method: "POST",
      headers: { authkey: secret.auth_key ?? "", "content-type": "application/json" },
      body: JSON.stringify({
        sender: msg.senderId ?? undefined,
        route: config.route || "4",
        country: msg.to.startsWith("+91") ? "91" : "0",
        DLT_TE_ID: msg.dltTemplateId ?? undefined,
        sms: [{ message: msg.body, to: [msg.to.startsWith("+91") ? msg.to.slice(3) : digitsOnly(msg.to)] }],
      }),
    });
    const body = json(text);
    if (status >= 300 || str(body.type) === "error") throw providerError("MSG91", status, str(body.message) || text);
    return str(body.message) || str(body.request_id) || `msg91-${Date.now()}`;
  },
  parseReports(payload) {
    // A form field "data" (or the JSON body) holding [{ requestId, report: [{ status, desc }] }].
    let items: unknown = payload.data ?? payload;
    if (typeof items === "string") items = json(`{"d":${items}}`).d;
    const list = Array.isArray(items) ? items : [items];
    const out: DeliveryReport[] = [];
    for (const item of list as Record<string, unknown>[]) {
      const id = str(item?.requestId ?? item?.request_id);
      const reports = Array.isArray(item?.report) ? (item.report as Record<string, unknown>[]) : [];
      for (const r of reports) {
        const code = str(r.status);
        if (!id || !code) continue;
        if (code === "1") out.push({ messageId: id, status: "delivered" });
        else if (code !== "8" && code !== "5") out.push({ messageId: id, status: "failed", error: str(r.desc) || `MSG91 status ${code}` });
      }
    }
    return out;
  },
};

// -- Twilio ---------------------------------------------------------------------------------------

const twilio: ProviderDef = {
  id: "twilio",
  name: "Twilio",
  website: "https://www.twilio.com",
  fields: [
    { key: "account_sid", label: "Account SID", secret: false, required: true, placeholder: "AC…" },
    { key: "auth_token", label: "Auth token", secret: true, required: true },
    { key: "messaging_service_sid", label: "Messaging service SID", secret: false, required: false, placeholder: "MG…", help: "Use this or a From number. For India, the service holds your DLT sender." },
    { key: "from", label: "From number or sender", secret: false, required: false, placeholder: "+1… or HEKENS" },
  ],
  reportSetup: "Nothing to set up: each text tells Twilio where to report.",
  async send(msg, config, secret) {
    const form = new URLSearchParams({ To: msg.to, Body: msg.body });
    if (config.messaging_service_sid) form.set("MessagingServiceSid", config.messaging_service_sid);
    else form.set("From", config.from || msg.senderId || "");
    if (msg.reportUrl) form.set("StatusCallback", msg.reportUrl);
    const sid = config.account_sid ?? "";
    const { status, text } = await call(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${sid}:${secret.auth_token ?? ""}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    const body = json(text);
    if (status >= 300) throw providerError("Twilio", status, str(body.message) || text);
    return str(body.sid);
  },
  parseReports(payload) {
    const id = str(payload.MessageSid ?? payload.SmsSid);
    const state = str(payload.MessageStatus ?? payload.SmsStatus);
    if (!id) return [];
    if (state === "delivered") return [{ messageId: id, status: "delivered" }];
    if (state === "failed" || state === "undelivered") return [{ messageId: id, status: "failed", error: str(payload.ErrorCode) ? `Twilio error ${str(payload.ErrorCode)}` : state }];
    return [];
  },
};

// -- 2Factor --------------------------------------------------------------------------------------

const twofactor: ProviderDef = {
  id: "twofactor",
  name: "2Factor",
  website: "https://2factor.in",
  fields: [{ key: "api_key", label: "API key", secret: true, required: true, help: "2Factor dashboard -> API key." }],
  reportSetup: "2Factor dashboard -> Transactional SMS -> delivery report (callback) URL: paste the address below.",
  async send(msg, _config, secret) {
    const form = new URLSearchParams({
      module: "TRANS_SMS",
      apikey: secret.api_key ?? "",
      to: digitsOnly(msg.to),
      from: msg.senderId ?? "",
      msg: msg.body,
    });
    if (msg.dltEntityId) form.set("peid", msg.dltEntityId);
    if (msg.dltTemplateId) form.set("ctid", msg.dltTemplateId);
    const { status, text } = await call("https://2factor.in/API/R1/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const body = json(text);
    if (status >= 300 || str(body.Status).toLowerCase() !== "success") throw providerError("2Factor", status, str(body.Details) || text);
    return str(body.Details) || `2factor-${Date.now()}`;
  },
  parseReports(payload) {
    const id = str(payload.SessionId ?? payload.session_id ?? payload.Details ?? payload.id);
    const state = str(payload.Status ?? payload.status).toUpperCase();
    if (!id || !state) return [];
    if (state.includes("DELIVERED") || state === "SUCCESS") return [{ messageId: id, status: "delivered" }];
    if (/FAIL|REJECT|UNDELIV|EXPIRED|DND/.test(state)) return [{ messageId: id, status: "failed", error: state }];
    return [];
  },
};

// -- Gupshup (Enterprise SMS) ----------------------------------------------------------------------

const gupshup: ProviderDef = {
  id: "gupshup",
  name: "Gupshup",
  website: "https://www.gupshup.io",
  fields: [
    { key: "userid", label: "User ID", secret: false, required: true },
    { key: "password", label: "Password", secret: true, required: true },
  ],
  reportSetup: "Ask Gupshup support to set your delivery report (DLR) URL to the address below.",
  async send(msg, config, secret) {
    const params = new URLSearchParams({
      method: "SendMessage",
      send_to: digitsOnly(msg.to),
      msg: msg.body,
      msg_type: "TEXT",
      userid: config.userid ?? "",
      auth_scheme: "plain",
      password: secret.password ?? "",
      v: "1.1",
      format: "json",
    });
    if (msg.senderId) params.set("mask", msg.senderId);
    if (msg.dltEntityId) params.set("principalEntityId", msg.dltEntityId);
    if (msg.dltTemplateId) params.set("dltTemplateId", msg.dltTemplateId);
    const { status, text } = await call("https://enterprise.smsgupshup.com/GatewayAPI/rest", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const response = (json(text).response ?? {}) as Record<string, unknown>;
    if (status >= 300 || str(response.status) !== "success") throw providerError("Gupshup", status, str(response.details) || text);
    return str(response.id);
  },
  parseReports(payload) {
    const id = str(payload.externalId ?? payload.external_id);
    const state = str(payload.status).toUpperCase();
    if (!id || !state) return [];
    if (state === "SUCCESS" || state === "DELIVERED") return [{ messageId: id, status: "delivered" }];
    return [{ messageId: id, status: "failed", error: str(payload.cause) || state }];
  },
};

export const PROVIDERS: Record<SmsProviderId, ProviderDef> = { msg91, twilio, twofactor, gupshup };

export function isProviderId(value: string): value is SmsProviderId {
  return (SMS_PROVIDERS as readonly string[]).includes(value);
}

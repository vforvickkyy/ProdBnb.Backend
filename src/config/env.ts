import "dotenv/config";
import { createPrivateKey } from "crypto";
import { z } from "zod";

/**
 * Normalizes the APNs `.p8` private key as it arrives from the environment.
 *
 * A PEM is inherently multi-line, but environment variables are carried as
 * single strings through several layers that each mangle newlines differently:
 *
 *  - `.env` + dotenv expands `\n` inside DOUBLE-quoted values, but leaves it
 *    literal in an unquoted one.
 *  - Vercel (and every other platform env UI) does not use dotenv at all, so a
 *    value pasted as one line keeps its `\n` sequences literally.
 *  - A quoted value pasted into a platform UI keeps its quotes, where dotenv
 *    would have stripped them.
 *
 * `crypto.createPrivateKey` rejects every one of those with
 * `ERR_OSSL_UNSUPPORTED`, and because the failure used to surface per-send it
 * looked like a generic delivery failure rather than a bad credential.
 *
 * This accepts all of those spellings and is a NO-OP on an already-correct PEM:
 * a real PEM contains no backslash-n sequence and no wrapping quotes, so every
 * branch below leaves it untouched. Only this one variable is normalized —
 * nothing else in the environment is rewritten.
 *
 * Never logs, returns or throws the key material.
 */
export function normalizeApnsPrivateKey(raw: string): string {
  let pem = raw.trim();

  // Wrapping quotes the platform kept but dotenv would have removed.
  const quote = pem[0];
  if (pem.length >= 2 && (quote === '"' || quote === "'") && pem.endsWith(quote)) {
    pem = pem.slice(1, -1).trim();
  }

  // Literal escape sequences standing in for real newlines. `\r\n` must be
  // handled before `\n`, or its `\r` half would survive as a stray newline.
  pem = pem.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\n");

  // Real CR/CRLF (a Windows paste) — OpenSSL wants LF.
  pem = pem.replace(/\r\n?/g, "\n");

  return pem.trim();
}

/**
 * Whether a normalized `APNS_PRIVATE_KEY` is actually usable for APNs ES256
 * signing, as a human-readable problem description, or `null` when it is fine.
 *
 * Deliberately returns a message rather than throwing, so the caller can route
 * it through the same zod issue reporting as every other env problem.
 *
 * **The returned string never contains any part of the key.** Only the OpenSSL
 * error *code*, the key type and the curve name are included — none of which is
 * secret — and never the underlying error message or the PEM itself.
 */
export function apnsPrivateKeyProblem(pem: string): string | null {
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(pem);
  } catch (err) {
    const code = err instanceof Error && "code" in err ? ` (${String((err as { code?: unknown }).code)})` : "";
    return (
      `APNS_PRIVATE_KEY is not a private key Node can parse${code}. Provide the .p8 ` +
      `file's full PEM contents, including the -----BEGIN PRIVATE KEY----- and ` +
      `-----END PRIVATE KEY----- lines. Real newlines and literal \\n escapes are ` +
      `both accepted.`
    );
  }

  // An APNs auth key is always EC P-256; anything else means the wrong file was
  // supplied (an RSA service key, a certificate's key, etc.). Signing would
  // fail per-send instead, which is exactly what this check exists to avoid.
  if (key.asymmetricKeyType !== "ec") {
    return (
      `APNS_PRIVATE_KEY parsed as a '${key.asymmetricKeyType}' key, but APNs token ` +
      `authentication requires the ES256 elliptic-curve .p8 key from Apple's Keys page.`
    );
  }

  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (curve !== undefined && curve !== "prime256v1") {
    return (
      `APNS_PRIVATE_KEY uses the '${curve}' curve, but APNs ES256 signing requires ` +
      `P-256 (prime256v1).`
    );
  }

  return null;
}

const baseEnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  /** The product's public name, as emails and pages show it. Never write the name into copy. */
  BRAND_NAME: z.string().trim().min(1).default("Heken"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0)
    ),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  R2_ACCOUNT_ID: z.string().min(1),
  R2_BUCKET_NAME: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_PUBLIC_BASE_URL: z.string().url(),
  R2_UPLOAD_URL_EXPIRY_SECONDS: z.coerce.number().int().positive().default(900),

  MEDIA_MAX_PHOTO_SIZE_MB: z.coerce.number().int().positive().default(20),
  MEDIA_MAX_VIDEO_SIZE_MB: z.coerce.number().int().positive().default(500),

  // This server's own publicly-reachable base URL — used to build the
  // webhook notify_url handed to payment providers server-side. Never
  // influenced by a client request.
  API_BASE_URL: z.string().url().default("http://localhost:4000"),

  // The website's on-demand refresh endpoint (https://<site>/api/revalidate) and the secret it
  // expects. When both are set, a change to a listing refreshes its website page at once instead of
  // after the page cache runs out (src/middleware/websiteRevalidate.ts). Optional: unset, nothing
  // is sent and pages refresh on their own timer.
  WEBSITE_REVALIDATE_URL: z.string().url().optional(),
  // The public website, for links in emails (booking pages, "Accept" confirm pages). Set per
  // environment: https://staging.heken.co on staging.
  WEBSITE_URL: z.string().url().default("https://heken.co"),
  // Where people can write back to (Reply-To on transactional emails). Optional.
  EMAIL_REPLY_TO: z.string().email().optional(),
  WEBSITE_REVALIDATE_SECRET: z.string().min(16).optional(),

  // Which PaymentProvider implementation is active (see
  // src/modules/payments/providers/index.ts). Only "cashfree" exists so far.
  PAYMENT_PROVIDER: z.enum(["cashfree"]).default("cashfree"),

  // Cashfree is test/sandbox-only in this phase — deliberately the only
  // accepted value, so switching to production Cashfree credentials later is
  // a conscious one-line schema change (adding "production" here plus its
  // host mapping in CashfreeProvider), never an accidental config typo.
  CASHFREE_ENV: z.enum(["test"]).default("test"),
  CASHFREE_APP_ID: z.string().min(1),
  CASHFREE_SECRET_KEY: z.string().min(1),
  CASHFREE_API_VERSION: z.string().min(1).default("2023-08-01"),

  // Which NotificationProvider implementation is active (see
  // src/modules/notifications/providers/index.ts). Defaults to "disabled" —
  // unlike PAYMENT_PROVIDER, this phase must remain fully testable with zero
  // Apple credentials, so "no provider configured" is the default, not an
  // error state. APNS_* below are validated as a group only when
  // NOTIFICATION_PROVIDER=apns is actually selected (see the .refine() below).
  NOTIFICATION_PROVIDER: z.enum(["disabled", "apns"]).default("disabled"),

  // Sandbox-only this phase, same enum-of-one pattern as CASHFREE_ENV.
  APNS_ENVIRONMENT: z.enum(["sandbox"]).default("sandbox"),
  APNS_TEAM_ID: z.string().min(1).optional(),
  APNS_KEY_ID: z.string().min(1).optional(),
  APNS_BUNDLE_ID: z.string().min(1).optional(),
  // The .p8 key's PEM contents. Server-only: never returned through an API,
  // never logged, never sent to any client.
  //
  // Normalized on the way in (see normalizeApnsPrivateKey), so everything
  // downstream — APNsProvider included — always receives a real multi-line PEM
  // regardless of how the host delivered it.
  APNS_PRIVATE_KEY: z
    .string()
    .min(1)
    .optional()
    .transform((value) => (value === undefined ? undefined : normalizeApnsPrivateKey(value))),
});

const envSchema = baseEnvSchema
  .refine(
    (value) =>
      value.NOTIFICATION_PROVIDER !== "apns" ||
      (value.APNS_TEAM_ID && value.APNS_KEY_ID && value.APNS_BUNDLE_ID && value.APNS_PRIVATE_KEY),
    {
      message:
        "NOTIFICATION_PROVIDER=apns requires APNS_TEAM_ID, APNS_KEY_ID, APNS_BUNDLE_ID, and APNS_PRIVATE_KEY to all be set.",
      path: ["NOTIFICATION_PROVIDER"],
    }
  )
  // A malformed key must fail HERE, at startup, rather than per-notification.
  // Before this, an unparseable PEM threw inside APNsProvider.send(), was
  // caught, and recorded as a generic `failed` delivery attempt on every
  // device — with nothing naming the credential as the cause.
  //
  // Only runs when the provider is actually selected, so the suite and every
  // deployment with NOTIFICATION_PROVIDER=disabled are unaffected. The
  // all-four-set check above owns the missing-value case, hence the guard.
  .superRefine((value, ctx) => {
    if (value.NOTIFICATION_PROVIDER !== "apns" || !value.APNS_PRIVATE_KEY) {
      return;
    }
    const problem = apnsPrivateKeyProblem(value.APNS_PRIVATE_KEY);
    if (problem !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, path: ["APNS_PRIVATE_KEY"] });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // `fieldErrors` is a map of field name -> issue MESSAGES. It never carries the
  // offending value, which is what makes it safe to print even when the failing
  // field is APNS_PRIVATE_KEY or a Supabase service key.
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  throw new Error("Missing or invalid environment variables. Check .env against .env.example.");
}

export const env = parsed.data;

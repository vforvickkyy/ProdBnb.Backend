import { execFileSync } from "child_process";
import { createPrivateKey, createSign, createVerify, generateKeyPairSync } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, it } from "vitest";
import { apnsPrivateKeyProblem, normalizeApnsPrivateKey } from "../src/config/env";

// A throwaway ES256 (P-256) key pair, generated per run and never written into
// the repository -- the same shape as an Apple APNs .p8 auth key, with none of
// its authority. No real credential is read, printed or committed by this file.
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const REAL_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

/** The documented single-line form: literal backslash-n in place of newlines. */
const ESCAPED_PEM = REAL_PEM.replace(/\n/g, "\\n");

/** A distinctive slice of the key body, used to prove no message leaks it. */
const SECRET_FRAGMENT = REAL_PEM.split("\n")[1]!.slice(0, 24);

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("normalizeApnsPrivateKey", () => {
  it("turns the documented literal-\\n single-line form back into a real PEM", () => {
    // Byte-for-byte equality with the original is the whole point: every
    // existing APNsProvider test already proves the provider signs correctly
    // given a real multi-line PEM, so an escaped value that normalizes to
    // exactly that PEM is proven to work through the provider too.
    expect(ESCAPED_PEM).not.toBe(REAL_PEM);
    expect(ESCAPED_PEM).toContain("\\n");
    expect(normalizeApnsPrivateKey(ESCAPED_PEM)).toBe(REAL_PEM.trim());
  });

  it("leaves an already-correct real-newline PEM untouched (idempotent)", () => {
    expect(normalizeApnsPrivateKey(REAL_PEM)).toBe(REAL_PEM.trim());
    // Applying it twice must not change anything either.
    expect(normalizeApnsPrivateKey(normalizeApnsPrivateKey(ESCAPED_PEM))).toBe(REAL_PEM.trim());
  });

  it("strips wrapping quotes a platform env UI kept but dotenv would have removed", () => {
    expect(normalizeApnsPrivateKey(`"${ESCAPED_PEM}"`)).toBe(REAL_PEM.trim());
    expect(normalizeApnsPrivateKey(`'${REAL_PEM}'`)).toBe(REAL_PEM.trim());
  });

  it("normalizes CRLF and literal \\r\\n without leaving stray blank lines", () => {
    expect(normalizeApnsPrivateKey(REAL_PEM.replace(/\n/g, "\r\n"))).toBe(REAL_PEM.trim());
    expect(normalizeApnsPrivateKey(REAL_PEM.replace(/\n/g, "\\r\\n"))).toBe(REAL_PEM.trim());
  });

  it("tolerates surrounding whitespace", () => {
    expect(normalizeApnsPrivateKey(`\n  ${ESCAPED_PEM}  \n`)).toBe(REAL_PEM.trim());
  });
});

describe("normalized key is usable by the APNs signing code", () => {
  it("an escaped PEM, once normalized, parses as an EC P-256 private key", () => {
    // The raw escaped value is exactly what used to reach node:crypto and fail.
    expect(() => createPrivateKey(ESCAPED_PEM)).toThrow();

    const key = createPrivateKey(normalizeApnsPrivateKey(ESCAPED_PEM));
    expect(key.asymmetricKeyType).toBe("ec");
    expect(key.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
  });

  it("produces a verifiable 64-byte raw ES256 signature via APNsProvider's exact call shape", () => {
    // Mirrors signApnsJwt() in src/modules/notifications/providers/APNsProvider.ts:
    // SHA256 + dsaEncoding "ieee-p1363" (the raw R||S form an ES256 JWT needs).
    const signingInput = "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJURUFNIn0";
    const signature = createSign("SHA256")
      .update(signingInput)
      .sign({ key: normalizeApnsPrivateKey(ESCAPED_PEM), dsaEncoding: "ieee-p1363" });

    expect(signature).toHaveLength(64);
    expect(
      createVerify("SHA256")
        .update(signingInput)
        .verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, signature)
    ).toBe(true);
  });
});

describe("apnsPrivateKeyProblem", () => {
  it("accepts a valid P-256 key in either spelling", () => {
    expect(apnsPrivateKeyProblem(REAL_PEM)).toBeNull();
    expect(apnsPrivateKeyProblem(normalizeApnsPrivateKey(ESCAPED_PEM))).toBeNull();
  });

  it("rejects the un-normalized escaped form, naming the OpenSSL code", () => {
    const problem = apnsPrivateKeyProblem(ESCAPED_PEM);
    expect(problem).toContain("APNS_PRIVATE_KEY");
    expect(problem).toContain("ERR_OSSL_UNSUPPORTED");
  });

  it("rejects a non-PEM value and truncated PEM without throwing", () => {
    expect(apnsPrivateKeyProblem("replace-with-your-apns-auth-key-pem")).not.toBeNull();
    expect(apnsPrivateKeyProblem("")).not.toBeNull();
    expect(apnsPrivateKeyProblem(REAL_PEM.slice(0, 80))).not.toBeNull();
  });

  it("rejects the wrong KIND of key — an RSA key parses but cannot do ES256", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const problem = apnsPrivateKeyProblem(rsa);
    expect(problem).toContain("rsa");
    expect(problem).toContain("ES256");
  });

  it("rejects an EC key on the wrong curve", () => {
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(apnsPrivateKeyProblem(p384)).toContain("prime256v1");
  });

  it("NEVER includes key material in any problem message", () => {
    // "Key material" means the base64 body. The armour lines
    // (-----BEGIN PRIVATE KEY-----) are a fixed label common to every PEM and
    // are quoted in the guidance ON PURPOSE, to tell the operator to include
    // them -- that is instruction, not disclosure.
    const candidates = [
      ESCAPED_PEM,
      REAL_PEM.slice(0, 80),
      `"${ESCAPED_PEM}"`,
      REAL_PEM.replace("-----BEGIN PRIVATE KEY-----", "-----BEGIN NONSENSE-----"),
    ];
    for (const candidate of candidates) {
      const problem = apnsPrivateKeyProblem(candidate) ?? "";
      expect(problem).not.toContain(SECRET_FRAGMENT);
      // No line of the supplied key is echoed back.
      for (const line of REAL_PEM.split("\n").filter((l) => l.length > 16 && !l.includes("-----"))) {
        expect(problem).not.toContain(line);
      }
      // Generic guard: no long unbroken base64 run of any kind.
      expect(problem).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
    }
  });
});

describe("startup validation (NOTIFICATION_PROVIDER=apns)", () => {
  /**
   * Loads src/config/env.ts in a real child process, so this exercises the
   * actual module-load-time failure an operator would hit on boot -- not a
   * re-implementation of it. Returns the child's exit status and output.
   */
  function bootEnv(overrides: Record<string, string>): { ok: boolean; output: string } {
    const dir = mkdtempSync(join(tmpdir(), "apns-env-"));
    tempDirs.push(dir);
    const probe = join(dir, "probe.ts");
    writeFileSync(
      probe,
      // Print only a marker and the provider name -- never the key.
      `import { env } from ${JSON.stringify(join(process.cwd(), "src/config/env.ts"))};\n` +
        `console.log("BOOT_OK:" + env.NOTIFICATION_PROVIDER);\n`
    );
    try {
      const stdout = execFileSync("npx", ["tsx", probe], {
        cwd: process.cwd(),
        env: { ...process.env, ...overrides },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, output: stdout };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  const apnsEnv = {
    NOTIFICATION_PROVIDER: "apns",
    APNS_ENVIRONMENT: "sandbox",
    APNS_TEAM_ID: "FAKETEAM01",
    APNS_KEY_ID: "FAKEKEYID9",
    APNS_BUNDLE_ID: "com.example.test",
  };

  it("boots when the key is supplied in the literal-\\n form", () => {
    const { ok, output } = bootEnv({ ...apnsEnv, APNS_PRIVATE_KEY: ESCAPED_PEM });
    expect(output).toContain("BOOT_OK:apns");
    expect(ok).toBe(true);
  });

  it("boots when the key is supplied with real newlines", () => {
    const { ok, output } = bootEnv({ ...apnsEnv, APNS_PRIVATE_KEY: REAL_PEM });
    expect(output).toContain("BOOT_OK:apns");
    expect(ok).toBe(true);
  });

  it("fails at startup on a malformed key, WITHOUT printing the key", () => {
    const { ok, output } = bootEnv({
      ...apnsEnv,
      APNS_PRIVATE_KEY: REAL_PEM.replace(/\n/g, "\\n").slice(0, 120),
    });

    expect(ok).toBe(false);
    expect(output).toContain("APNS_PRIVATE_KEY");
    expect(output).toContain("Missing or invalid environment variables");
    // The failure names the variable and the OpenSSL code, never the value:
    // no base64 body from the supplied key appears anywhere in the output.
    expect(output).toContain("ERR_OSSL_UNSUPPORTED");
    expect(output).not.toContain(SECRET_FRAGMENT);
    for (const line of REAL_PEM.split("\n").filter((l) => l.length > 16 && !l.includes("-----"))) {
      expect(output).not.toContain(line);
    }
  });

  it("still boots with the provider disabled even if the key is malformed", () => {
    // The check is scoped to NOTIFICATION_PROVIDER=apns on purpose: every
    // deployment and test run that leaves it disabled must be unaffected.
    const { ok, output } = bootEnv({
      NOTIFICATION_PROVIDER: "disabled",
      APNS_PRIVATE_KEY: "not-a-pem-at-all",
    });
    expect(output).toContain("BOOT_OK:disabled");
    expect(ok).toBe(true);
  });
});

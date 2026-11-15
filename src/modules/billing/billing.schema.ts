import { z } from "zod";

/**
 * GSTIN structure, mirroring the database CHECK constraint exactly:
 *
 *   27  AAPFU0939F  1  Z  V
 *   │   │           │  │  └─ checksum (mod-36)
 *   │   │           │  └──── literal 'Z'
 *   │   │           └─────── entity number for the PAN within the state
 *   │   └─────────────────── 10-character PAN
 *   └─────────────────────── 2-digit state code
 */
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/** `0-9` then `A-Z`: position in this alphabet is the digit's value in the mod-36 checksum. */
const CHECKSUM_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Validates a GSTIN's trailing check character.
 *
 * The algorithm is fully offline and self-contained: each of the first 14 characters is weighted
 * alternately 1 and 2, each product is folded (`quotient + remainder` in base 36), the total is
 * summed, and the check character is whatever completes it to a multiple of 36.
 *
 * **No external GST validation service is called, and none is invented.** Verifying that a GSTIN is
 * genuinely *registered* requires India's GST portal; this confirms only that the number is
 * well-formed and internally consistent, which is the strongest claim that can honestly be made
 * offline. Exported so tests can exercise it directly.
 */
export function hasValidGstinChecksum(gstin: string): boolean {
  if (gstin.length !== 15) {
    return false;
  }

  let total = 0;
  for (let index = 0; index < 14; index += 1) {
    // `noUncheckedIndexedAccess` is on, so an index read is `string | undefined`. The length check
    // above makes this safe, but the compiler is right to insist it be stated.
    const character = gstin[index];
    if (character === undefined) {
      return false;
    }
    const value = CHECKSUM_ALPHABET.indexOf(character);
    if (value < 0) {
      return false;
    }
    const weight = index % 2 === 0 ? 1 : 2;
    const product = value * weight;
    total += Math.floor(product / 36) + (product % 36);
  }

  const expectedIndex = (36 - (total % 36)) % 36;
  return CHECKSUM_ALPHABET[expectedIndex] === gstin[14];
}

/**
 * One GSTIN, or `null` to clear it.
 *
 * Sanitisation happens before validation, deliberately: users paste GSTINs with spaces and in lower
 * case, and rejecting `"27aapfu0939f1zv"` outright would be pedantry rather than protection. What is
 * *stored* is always the canonical uppercase form with no whitespace, so the database only ever
 * holds one representation of a given number.
 */
const gstNumberSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, "").toUpperCase())
  .refine((value) => GSTIN_PATTERN.test(value), "Enter a valid 15-character GST number.")
  .refine(hasValidGstinChecksum, "That GST number's check digit is incorrect. Please re-enter it.");

/**
 * Company name. Trimmed, and an empty string is rejected rather than silently treated as a clear —
 * so "I meant to erase this" (`null`) and "my form submitted a blank field" can never be confused.
 * The same rule `users.schema.ts` applies to every address part.
 */
const companyNameSchema = z.string().trim().min(1, "Enter a company name.").max(200);

/**
 * `PUT /v1/me/billing`.
 *
 * A full replacement rather than a patch: billing details are a small, cohesive set, and "replace
 * what I have with this" is easier to reason about than three-way per-field semantics. Both fields
 * are `.optional().nullable()`, so an omitted or null field clears that value.
 *
 * `.strict()`, matching `updateProfileSchema`: an unrecognised key is a 400 rather than being
 * silently dropped. That also means `user_id`, `created_at` and `updated_at` are not writable
 * through this endpoint at all — ownership comes from the session, never from the body.
 */
export const putBillingSchema = z
  .object({
    company_name: companyNameSchema.optional().nullable(),
    gst_number: gstNumberSchema.optional().nullable(),
  })
  .strict();

export type PutBillingInput = z.infer<typeof putBillingSchema>;

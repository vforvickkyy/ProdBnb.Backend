import { z } from "zod";

/** Host payouts: bank details, earnings and the payouts the team records. */

const uuid = z.string().uuid();

/** Spaces and dashes people type in account numbers are dropped; what's left must be 9-18 digits. */
const accountNumber = z
  .string()
  .transform((v) => v.replace(/[\s-]/g, ""))
  .refine((v) => /^[0-9]{9,18}$/.test(v), "Enter the account number: 9 to 18 digits.");

export const savePayoutAccountSchema = z
  .object({
    account_holder_name: z.string().trim().min(2, "Enter the name on the account.").max(120),
    account_number: accountNumber,
    ifsc: z
      .string()
      .transform((v) => v.replace(/\s/g, "").toUpperCase())
      .refine((v) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v), "Enter a valid 11-character IFSC, like HDFC0001234."),
    bank_name: z.string().trim().min(1).max(120).nullable().optional(),
    pan: z
      .string()
      .transform((v) => v.replace(/\s/g, "").toUpperCase())
      .refine((v) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v), "Enter a valid 10-character PAN, like ABCDE1234F."),
  })
  .strict();
export type SavePayoutAccountInput = z.infer<typeof savePayoutAccountSchema>;

export const hostIdParamSchema = z.object({ id: uuid });
export type HostIdParam = z.infer<typeof hostIdParamSchema>;

export const recordPayoutSchema = z
  .object({
    booking_ids: z.array(uuid).min(1).max(500),
    /** The bank's reference for the transfer (UTR / NEFT / IMPS). */
    reference: z.string().trim().min(1).max(100),
    /** When the money was sent; defaults to now. */
    paid_at: z.string().datetime({ offset: true }).optional(),
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
export type RecordPayoutInput = z.infer<typeof recordPayoutSchema>;

export const listPayoutsQuerySchema = z
  .object({
    host_id: uuid.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type ListPayoutsQuery = z.infer<typeof listPayoutsQuerySchema>;

export const earningStateSchema = z.enum(["upcoming", "ready", "on_hold", "paid", "not_payable"]);
export type EarningState = z.infer<typeof earningStateSchema>;

import { z } from "zod";

const uuid = z.string().uuid();
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const settingsFields = z
  .object({
    legal_name: text(160),
    trade_name: text(120),
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^([0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z])?$/, "A GSTIN is 15 characters, like 27AABCU9603R1ZM.")
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .optional(),
    pan: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^([A-Z]{5}[0-9]{4}[A-Z])?$/, "A PAN is 10 characters, like ABCDE1234F.")
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .optional(),
    address_line1: text(160),
    address_line2: text(160),
    city: text(80),
    state: text(80),
    state_code: z
      .string()
      .trim()
      .regex(/^([0-9]{2})?$/, "The state code is two digits, like 27 for Maharashtra.")
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .optional(),
    postal_code: text(12),
    country: z.string().trim().min(2).max(60).optional(),
    email: z
      .string()
      .trim()
      .max(200)
      .refine((v) => v === "" || z.string().email().safeParse(v).success, "Enter a valid email address.")
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .optional(),
    phone: text(30),
    website: text(200),
    number_prefix: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{1,4}$/, "Use 1–4 letters or digits, like INV.")
      .optional(),
    sac_code: z
      .string()
      .trim()
      .regex(/^([0-9]{4,8})?$/, "A SAC code is 4–8 digits, like 997212.")
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .optional(),
    tax_label: z.string().trim().min(1).max(20).optional(),
    notes: text(1000),
    terms: text(2000),
    signatory: text(120),
    auto_send: z.boolean().optional(),
  })
  .strict();

export const invoiceSettingsSchema = settingsFields.refine((d) => Object.keys(d).length > 0, { message: "Provide at least one field to update." });
export type InvoiceSettingsInput = z.infer<typeof invoiceSettingsSchema>;

export const invoiceIdParamSchema = z.object({ id: uuid });
export const paymentIdParamSchema = z.object({ id: uuid });

export const listInvoicesQuerySchema = z.object({
  filter: z.enum(["all", "pending", "sent_auto", "sent_manual", "failed"]).default("all"),
  search: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;

export const listReceiptsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListReceiptsQuery = z.infer<typeof listReceiptsQuerySchema>;

export const sendSchema = z
  .object({
    to: z.string().trim().email("Enter a valid email address.").max(200).optional(),
  })
  .strict();
export type SendInput = z.infer<typeof sendSchema>;

/** Unsaved template values, for the preview: same fields, none required. */
export const invoicePreviewSchema = settingsFields;

import { z } from "zod";

/** Booker account (website): refund requests, account deletion, payment history, profile photo. */

const uuid = z.string().uuid();
const note = (max: number) => z.string().trim().min(1).max(max);

export const idParamSchema = z.object({ id: uuid });
export type IdParam = z.infer<typeof idParamSchema>;

export const createRefundRequestSchema = z
  .object({
    /** What went wrong. Shown to the admin team; required so they can act on it. */
    reason: note(1000),
  })
  .strict();
export type CreateRefundRequestInput = z.infer<typeof createRefundRequestSchema>;

export const myRefundRequestsQuerySchema = z
  .object({
    booking_id: uuid.optional(),
  })
  .strict();
export type MyRefundRequestsQuery = z.infer<typeof myRefundRequestsQuerySchema>;

export const myPaymentsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type MyPaymentsQuery = z.infer<typeof myPaymentsQuerySchema>;

export const deletionRequestSchema = z
  .object({
    reason: note(1000).optional(),
  })
  .strict()
  .default({});
export type DeletionRequestInput = z.infer<typeof deletionRequestSchema>;

// Admin -----------------------------------------------------------------------------------------

export const refundRequestStatusSchema = z.enum(["pending", "approved", "declined", "withdrawn"]);
export const adminRefundRequestsQuerySchema = z
  .object({
    status: refundRequestStatusSchema.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type AdminRefundRequestsQuery = z.infer<typeof adminRefundRequestsQuerySchema>;

export const approveRefundRequestSchema = z
  .object({
    /** Minor units (paise). Omit to refund everything still refundable on the payment. */
    amount_minor_units: z.number().int().positive().optional(),
    /** Shown to the booker. */
    note: note(1000).optional(),
  })
  .strict()
  .default({});
export type ApproveRefundRequestInput = z.infer<typeof approveRefundRequestSchema>;

export const declineSchema = z
  .object({
    /** Required: the booker (or user) is told why. */
    note: note(1000),
  })
  .strict();
export type DeclineInput = z.infer<typeof declineSchema>;

export const deletionRequestStatusSchema = z.enum(["pending", "completed", "declined", "withdrawn"]);
export const adminDeletionRequestsQuerySchema = z
  .object({
    status: deletionRequestStatusSchema.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type AdminDeletionRequestsQuery = z.infer<typeof adminDeletionRequestsQuerySchema>;

export const completeDeletionSchema = z
  .object({
    note: note(1000).optional(),
  })
  .strict()
  .default({});
export type CompleteDeletionInput = z.infer<typeof completeDeletionSchema>;

/** Profile photos: what the browser may send as the raw request body. */
export const AVATAR_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

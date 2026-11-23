import { z } from "zod";
import { profilePhoneSchema } from "../users/users.schema";

/**
 * "Request a callback": someone who wants to list a place asks the team to call and help them get
 * listed. Signed-in people only; one open request (new or contacted) per person.
 */

export const HOST_REQUEST_BEST_TIMES = ["morning", "afternoon", "evening", "anytime"] as const;
export const HOST_REQUEST_STATUSES = ["new", "contacted", "done", "closed", "withdrawn"] as const;
/** What the team can set. `withdrawn` is the person's own decision only. */
export const HOST_REQUEST_ADMIN_STATUSES = ["new", "contacted", "done", "closed"] as const;

export type HostRequestBestTime = (typeof HOST_REQUEST_BEST_TIMES)[number];
export type HostRequestStatus = (typeof HOST_REQUEST_STATUSES)[number];

/** Optional free text: blank means "not given", so a form can send "" for an untouched field. */
const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.string().trim().max(max).nullable().optional()
  );

export const hostRequestSchema = z
  .object({
    name: z.string().trim().min(1, "Enter your name.").max(120),
    phone: profilePhoneSchema,
    city: optionalText(120),
    /** The kind of place, in their words or a category name: "Bungalow", "Rooftop cafe". */
    space_type: optionalText(120),
    best_time: z.enum(HOST_REQUEST_BEST_TIMES).default("anytime"),
    note: optionalText(1000),
    /** The draft listing they have started, if any. Must be their own. */
    location_id: z.string().uuid().nullable().optional(),
  })
  .strict();
export type HostRequestInput = z.infer<typeof hostRequestSchema>;

export const hostRequestIdParamSchema = z.object({ id: z.string().uuid() });
export type HostRequestIdParam = z.infer<typeof hostRequestIdParamSchema>;

export const adminHostRequestsQuerySchema = z
  .object({
    /** A status, or `open` for new + contacted together. */
    status: z.enum([...HOST_REQUEST_STATUSES, "open"]).optional(),
    /** Name, phone, email or city. */
    search: z.string().trim().min(1).max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type AdminHostRequestsQuery = z.infer<typeof adminHostRequestsQuerySchema>;

export const updateHostRequestSchema = z
  .object({
    status: z.enum(HOST_REQUEST_ADMIN_STATUSES).optional(),
    /** The team's own notes. Never shown to the person. `null` clears them. */
    admin_notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((value) => value.status !== undefined || value.admin_notes !== undefined, {
    message: "Change the status or the notes.",
  });
export type UpdateHostRequestInput = z.infer<typeof updateHostRequestSchema>;

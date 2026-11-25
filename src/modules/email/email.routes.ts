import { Request, Response, Router } from "express";
import { z } from "zod";
import { NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { validate } from "../../middleware/validate";
import { ok } from "../../utils/respond";
import { requirePermission as can } from "../admin/permissions";
import { confirmBooking, rejectBooking } from "../bookings/bookings.service";
import { verifyEmailAction } from "./actions";
import { loadBooking } from "./context";
import { money, whenLabel } from "./layout";
import { emailSummary, listEmails, listSuppressions, removeSuppression, resendEmail } from "./outbox.service";
import { getEmailPreferences, updateEmailPreferences } from "./preferences.service";
import { requireAuth } from "../../middleware/auth";
import { EMAIL_TEMPLATES } from "./templates";

/**
 * Public: the website's "Accept / Decline from email" confirm page. The signed token is the only
 * credential -- it names one booking, its host and one action -- and the booking must still be
 * waiting for an answer.
 */
export const emailActionsRouter = Router();

const tokenParams = z.object({ token: z.string().min(20).max(600) });
const actionBody = z.object({ reason: z.string().trim().max(500).optional() }).strict().default({});

async function resolve(token: string) {
  const claims = await verifyEmailAction(token);
  if (!claims) throw new ValidationError("This link has expired or isn't valid. Open the booking in your host dashboard instead.");
  const booking = await loadBooking(claims.b);
  if (!booking || booking.location.host_id !== claims.h) throw new NotFoundError("Booking not found.");
  return { claims, booking };
}

emailActionsRouter.get("/email-actions/:token", validate({ params: tokenParams }), async (req: Request, res: Response) => {
  const { claims, booking: b } = await resolve((req.valid!.params as { token: string }).token);
  ok(res, {
    action: claims.a,
    booking_id: b.id,
    status: b.status,
    // Already answered, expired or cancelled: the page says so instead of offering the button.
    actionable: b.status === "requested" && b.pricing_status !== "awaiting_quote",
    place: b.location.title,
    when: whenLabel(b.start_at, b.end_at, b.location.timezone),
    booker_name: b.booker.name,
    crew_size: b.crew_size,
    shoot_type: b.shoot_type,
    your_price: money(b.base_amount_minor_units, b.currency),
  });
});

emailActionsRouter.post(
  "/email-actions/:token",
  validate({ params: tokenParams, body: actionBody }),
  async (req: Request, res: Response) => {
    const { claims, booking: b } = await resolve((req.valid!.params as { token: string }).token);
    if (b.status !== "requested") {
      throw new ValidationError(b.status === "confirmed" ? "This booking is already accepted." : `This booking is ${b.status} and can't be answered any more.`);
    }
    const body = req.valid!.body as z.infer<typeof actionBody>;
    // Acts as the host: the same checks as the host's own Accept/Decline buttons.
    const updated =
      claims.a === "accept"
        ? await confirmBooking(adminClient, claims.h, false, b.id)
        : await rejectBooking(adminClient, claims.h, false, b.id, { reason: body.reason });
    ok(res, { booking_id: updated.id, status: updated.status });
  }
);

// -- The signed-in person's email settings ---------------------------------------------------------

const preferencesBody = z.object({ news_and_offers: z.boolean() }).strict();

emailActionsRouter.get("/me/email-preferences", requireAuth, async (req: Request, res: Response) => {
  ok(res, await getEmailPreferences(req.user!.id));
});

emailActionsRouter.patch("/me/email-preferences", requireAuth, validate({ body: preferencesBody }), async (req: Request, res: Response) => {
  ok(res, await updateEmailPreferences(req.user!.id, req.valid!.body as z.infer<typeof preferencesBody>));
});

/** Admin: the email log (Messaging -> Email log). Mounted inside the admin router. */
export const adminEmailsRouter = Router();

const statusSchema = z.enum(["queued", "sending", "sent", "failed", "skipped"]);
const listQuery = z
  .object({
    status: statusSchema.optional(),
    template: z.enum(EMAIL_TEMPLATES).optional(),
    search: z.string().trim().min(1).max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
const idParams = z.object({ id: z.string().uuid() });

adminEmailsRouter.get("/emails", can("campaigns.view"), validate({ query: listQuery }), async (req: Request, res: Response) => {
  const query = req.valid!.query as z.infer<typeof listQuery>;
  const { data, total } = await listEmails(query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
});

adminEmailsRouter.get("/emails/summary", can("campaigns.view"), async (_req: Request, res: Response) => {
  ok(res, await emailSummary());
});

adminEmailsRouter.post("/emails/:id/resend", can("campaigns.send"), validate({ params: idParams }), async (req: Request, res: Response) => {
  ok(res, await resendEmail((req.valid!.params as { id: string }).id));
});

const suppressionQuery = z
  .object({
    reason: z.enum(["unsubscribed", "bounced", "admin"]).optional(),
    search: z.string().trim().min(1).max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
const suppressionParams = z.object({ email: z.string().trim().email().max(320) });

adminEmailsRouter.get("/emails/suppressions", can("campaigns.view"), validate({ query: suppressionQuery }), async (req: Request, res: Response) => {
  const query = req.valid!.query as z.infer<typeof suppressionQuery>;
  const { data, total } = await listSuppressions(query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
});

adminEmailsRouter.delete("/emails/suppressions/:email", can("campaigns.send"), validate({ params: suppressionParams }), async (req: Request, res: Response) => {
  await removeSuppression((req.valid!.params as z.infer<typeof suppressionParams>).email);
  ok(res, { removed: true });
});

import { Request, Response } from "express";
import { writeAuditLog } from "../admin/audit.service";
import { callerHasAdminPermission } from "../admin/permissions";
import { created, ok } from "../../utils/respond";
import { withContacts } from "./contacts";
import {
  cancelBooking,
  completeBooking,
  confirmBooking,
  createBooking,
  quoteBooking,
  getBooking,
  listBookings,
  rejectBooking,
} from "./bookings.service";
import { BookingActionInput, BookingIdParam, CreateBookingInput, ListBookingsQuery } from "./bookings.schema";

// Admin Console: "may this caller act as an administrator here" is a team-role permission,
// not bare admin-role membership -- see src/modules/admin/permissions.ts.
async function isCallerAdmin(req: Request): Promise<boolean> {
  return callerHasAdminPermission(req, "bookings.manage");
}

export async function postBooking(req: Request, res: Response): Promise<void> {
  const input = req.valid!.body as CreateBookingInput;
  const booking = await createBooking(req.supabase!, req.user!.id, input);
  created(res, booking);
}

export async function postBookingQuote(req: Request, res: Response): Promise<void> {
  const input = req.valid!.body as CreateBookingInput;
  ok(res, await quoteBooking(req.supabase!, req.user!.id, input));
}

export async function getBookings(req: Request, res: Response): Promise<void> {
  const query = req.valid!.query as ListBookingsQuery;
  const { data, total } = await listBookings(req.supabase!, query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
}

export async function getBookingDetail(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as BookingIdParam;
  const booking = await getBooking(req.supabase!, id);
  ok(res, await withContacts(booking, req.user!.id));
}

export async function postConfirmBooking(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as BookingIdParam;
  const isAdmin = await isCallerAdmin(req);
  const booking = await confirmBooking(req.supabase!, req.user!.id, isAdmin, id);
  ok(res, booking);
}

export async function postRejectBooking(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as BookingIdParam;
  const input = req.valid!.body as BookingActionInput;
  const isAdmin = await isCallerAdmin(req);
  const booking = await rejectBooking(req.supabase!, req.user!.id, isAdmin, id, input);
  ok(res, booking);
}

export async function postCancelBooking(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as BookingIdParam;
  const input = req.valid!.body as BookingActionInput;
  const isAdmin = await isCallerAdmin(req);
  const booking = await cancelBooking(req.supabase!, req.user!.id, isAdmin, id, input);
  // This route accepts the same admin-cancel capability as the dedicated
  // POST /v1/admin/bookings/:id/cancel (Phase 11) -- audited identically
  // here so an admin can't get a silent, unaudited cancellation just by
  // using the older route instead of the newer one (Phase 12).
  if (isAdmin) {
    await writeAuditLog(req.user!.id, "ADMIN_CANCELLED_BOOKING", "booking", id, input.reason ?? null, {});
  }
  ok(res, booking);
}

export async function postCompleteBooking(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as BookingIdParam;
  const isAdmin = await isCallerAdmin(req);
  const booking = await completeBooking(req.supabase!, req.user!.id, isAdmin, id);
  ok(res, booking);
}

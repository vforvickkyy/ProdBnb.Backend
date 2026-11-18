import { Request, Response } from "express";
import { ForbiddenError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { created, ok } from "../../utils/respond";
import { holdDeadline } from "../bookings/holds";
import { BookingActionInput, BookingIdParam } from "../bookings/bookings.schema";
import { BookingDetail, completeBooking, confirmBooking, rejectBooking } from "../bookings/bookings.service";
import { updateLocation } from "../locations/locations.service";
import { deleteMedia, listMedia } from "../media/media.service";
import { PaymentIdParam } from "../payments/payment.schema";
import { verifyPayment } from "../payments/payment.service";
import { getPlatformSettings, updatePlatformSettings } from "../platform/settings.service";
import { deleteSection, listSectionMedia, listSections } from "../sections/sections.service";
import {
  AddTeamMemberInput,
  AdminConversationsQuery,
  AdminUpdateLocationInput,
  AnalyticsQuery,
  AttentionQuery,
  CatalogItemParam,
  CatalogKindParam,
  CatalogNameInput,
  CatalogUpdateInput,
  ConversationIdParam,
  IntegrationsQuery,
  LocationMediaParam,
  LocationSectionParam,
  MessageAccessLogQuery,
  OpenConversationInput,
  OptionalReasonInput,
  SetTeamRoleInput,
  TeamUserIdParam,
  UpdateSettingsInput,
  UserRoleParam,
} from "./admin.schema";
import { LocationIdParam } from "../locations/locations.schema";
import { writeAuditLog } from "./audit.service";
import { createCatalogItem, deleteCatalogItem, listCatalog, renameCatalogItem } from "./catalog.service";
import { listConversationsForAdmin, listMessageAccessLog, openConversationForAdmin } from "./conversations.service";
import { getIntegrationsReport } from "./integrations.service";
import { listPaymentsNeedingAttention } from "./payments.service";
import { getCallerTeamRole } from "./permissions";
import { addTeamMemberByEmail, getAdminMe, listTeam, removeTeamMember, setTeamMember } from "./team.service";
import { grantUserRole, revokeUserRole } from "./users.service";
import { clearSiteConfigCache } from "../site/integrations.service";

/**
 * Admin Console endpoints. Every route here sits behind adminRouter's requireAuth +
 * requireRole("admin") gate AND a per-route requirePermission(...) (admin.routes.ts), so a
 * handler never re-checks the caller's role -- only business rules.
 *
 * `isAdmin = true` is passed to the shared booking/location services deliberately: the permission
 * check that decides whether this caller may act as an admin on that resource already ran.
 */

const SETTLED = new Set(["success", "partially_refunded", "refunded"]);

/** Adds when an unpaid active booking's hold lapses -- an admin-only, informational field. */
export function withHoldDeadline<T extends BookingDetail>(booking: T, holdMinutes: number | null): T & { hold_expires_at: string | null } {
  const active = booking.status === "requested" || booking.status === "confirmed";
  const paid = booking.payments.some((p) => SETTLED.has(p.status));
  // Same rule as expire_unpaid_bookings(): a request waiting for a price holds nothing; a quoted one
  // has at least 24 hours from the quote.
  if (!active || paid || booking.pricing_status === "awaiting_quote") {
    return { ...booking, hold_expires_at: null };
  }
  if (booking.pricing_status === "quoted" && holdMinutes !== null) {
    return { ...booking, hold_expires_at: holdDeadline(booking.quoted_at ?? booking.created_at, Math.max(holdMinutes, 1440)) };
  }
  return { ...booking, hold_expires_at: holdDeadline(booking.created_at, holdMinutes) };
}

// -- Me / team ----------------------------------------------------------------------------------

export async function getMeHandler(req: Request, res: Response): Promise<void> {
  const role = await getCallerTeamRole(req);
  if (!role) {
    throw new ForbiddenError("This account has no admin team role.");
  }
  ok(res, await getAdminMe(req.user!.id, req.user!.email, role));
}

export async function getTeamHandler(_req: Request, res: Response): Promise<void> {
  ok(res, await listTeam());
}

export async function postTeamMemberHandler(req: Request, res: Response): Promise<void> {
  const { email, team_role } = req.valid!.body as AddTeamMemberInput;
  created(res, await addTeamMemberByEmail(req.user!.id, email, team_role));
}

export async function putTeamMemberHandler(req: Request, res: Response): Promise<void> {
  const { userId } = req.valid!.params as TeamUserIdParam;
  const { team_role } = req.valid!.body as SetTeamRoleInput;
  ok(res, await setTeamMember(req.user!.id, userId, team_role));
}

export async function deleteTeamMemberHandler(req: Request, res: Response): Promise<void> {
  const { userId } = req.valid!.params as TeamUserIdParam;
  await removeTeamMember(req.user!.id, userId);
  ok(res, { removed: true });
}

// -- Platform settings ----------------------------------------------------------------------------

export async function getSettingsHandler(_req: Request, res: Response): Promise<void> {
  ok(res, await getPlatformSettings({ fresh: true }));
}

export async function patchSettingsHandler(req: Request, res: Response): Promise<void> {
  const { reason, ...patch } = req.valid!.body as UpdateSettingsInput;
  const before = await getPlatformSettings({ fresh: true });
  const after = await updatePlatformSettings(req.user!.id, patch);

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of ["platform_fee_bps", "tax_bps", "unpaid_hold_minutes", "availability_requires_login"] as const) {
    if (patch[key] !== undefined && before[key] !== after[key]) {
      changes[key] = { from: before[key], to: after[key] };
    }
  }
  await writeAuditLog(req.user!.id, "ADMIN_UPDATED_SETTINGS", "settings", after.id, reason ?? null, { changes });
  clearSiteConfigCache();
  ok(res, after);
}

// -- Catalog ----------------------------------------------------------------------------------------

export async function getCatalogHandler(req: Request, res: Response): Promise<void> {
  const { kind } = req.valid!.params as CatalogKindParam;
  ok(res, await listCatalog(kind));
}

export async function postCatalogItemHandler(req: Request, res: Response): Promise<void> {
  const { kind } = req.valid!.params as CatalogKindParam;
  const { name, description } = req.valid!.body as CatalogNameInput;
  created(res, await createCatalogItem(req.user!.id, kind, name, description ?? null));
}

export async function patchCatalogItemHandler(req: Request, res: Response): Promise<void> {
  const { kind, itemId } = req.valid!.params as CatalogItemParam;
  const patch = req.valid!.body as CatalogUpdateInput;
  ok(res, await renameCatalogItem(req.user!.id, kind, itemId, patch));
}

export async function deleteCatalogItemHandler(req: Request, res: Response): Promise<void> {
  const { kind, itemId } = req.valid!.params as CatalogItemParam;
  await deleteCatalogItem(req.user!.id, kind, itemId);
  ok(res, { deleted: true });
}

// -- Listing moderation -------------------------------------------------------------------------------

export async function patchAdminLocationHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const { reason, ...fields } = req.valid!.body as AdminUpdateLocationInput;
  ok(res, await updateLocation(req.supabase!, req.user!.id, true, id, fields, reason ?? null));
}

/** Every photo on a listing, general gallery and each section's, in one response. */
export async function getAdminLocationGalleryHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdParam;
  const [general, sections] = await Promise.all([listMedia(req.supabase!, id), listSections(req.supabase!, id)]);
  const sectionGalleries = await Promise.all(
    sections.map(async (section) => ({ section, media: await listSectionMedia(req.supabase!, id, section.id) }))
  );
  ok(res, { general, sections: sectionGalleries });
}

export async function deleteAdminLocationMediaHandler(req: Request, res: Response): Promise<void> {
  const { id, mediaId } = req.valid!.params as LocationMediaParam;
  const { reason } = req.valid!.body as OptionalReasonInput;
  await deleteMedia(req.supabase!, req.user!.id, true, id, mediaId, reason ?? null);
  ok(res, { deleted: true });
}

export async function deleteAdminLocationSectionHandler(req: Request, res: Response): Promise<void> {
  const { id, sectionId } = req.valid!.params as LocationSectionParam;
  const { reason } = req.valid!.body as OptionalReasonInput;
  await deleteSection(req.supabase!, req.user!.id, true, id, sectionId, reason ?? null);
  ok(res, { deleted: true });
}

// -- Booking actions ----------------------------------------------------------------------------------

export async function postAdminConfirmBookingHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as BookingIdParam;
  const booking = await confirmBooking(req.supabase!, req.user!.id, true, id);
  await writeAuditLog(req.user!.id, "ADMIN_CONFIRMED_BOOKING", "booking", id, null, {});
  ok(res, booking);
}

export async function postAdminRejectBookingHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as BookingIdParam;
  const input = req.valid!.body as BookingActionInput;
  const booking = await rejectBooking(req.supabase!, req.user!.id, true, id, input);
  await writeAuditLog(req.user!.id, "ADMIN_REJECTED_BOOKING", "booking", id, input.reason ?? null, {});
  ok(res, booking);
}

export async function postAdminCompleteBookingHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as BookingIdParam;
  const booking = await completeBooking(req.supabase!, req.user!.id, true, id);
  await writeAuditLog(req.user!.id, "ADMIN_COMPLETED_BOOKING", "booking", id, null, {});
  ok(res, booking);
}

// -- Payments ---------------------------------------------------------------------------------------

/** Re-asks the provider for the truth (the same guarded path the webhook uses). Audited. */
export async function postAdminVerifyPaymentHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as PaymentIdParam;
  const before = await adminClient.from("payments").select("status").eq("id", id).maybeSingle();
  const payment = await verifyPayment(req.supabase!, id);
  await writeAuditLog(req.user!.id, "ADMIN_VERIFIED_PAYMENT", "payment", id, null, {
    previous_status: before.data?.status ?? null,
    new_status: payment.status,
  });
  ok(res, payment);
}

export async function getPaymentsAttentionHandler(req: Request, res: Response): Promise<void> {
  const { page, pageSize } = req.valid!.query as AttentionQuery;
  const { data, total } = await listPaymentsNeedingAttention(req.supabase!, page, pageSize);
  ok(res, data, 200, { page, pageSize, total });
}

// -- People -------------------------------------------------------------------------------------------

export async function postUserRoleHandler(req: Request, res: Response): Promise<void> {
  const { id, role } = req.valid!.params as UserRoleParam;
  created(res, await grantUserRole(req.user!.id, id, role));
}

export async function deleteUserRoleHandler(req: Request, res: Response): Promise<void> {
  const { id, role } = req.valid!.params as UserRoleParam;
  ok(res, await revokeUserRole(req.user!.id, id, role));
}

// -- Dispute message access ---------------------------------------------------------------------------

export async function getAdminConversationsHandler(req: Request, res: Response): Promise<void> {
  const query = req.valid!.query as AdminConversationsQuery;
  const { data, total } = await listConversationsForAdmin(query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
}

export async function postOpenConversationHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as ConversationIdParam;
  const { reason } = req.valid!.body as OpenConversationInput;
  ok(res, await openConversationForAdmin(req.user!.id, id, reason));
}

export async function getMessageAccessLogHandler(req: Request, res: Response): Promise<void> {
  const query = req.valid!.query as MessageAccessLogQuery;
  const { data, total } = await listMessageAccessLog(query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
}

// -- Analytics / integrations ---------------------------------------------------------------------------

export async function getAnalyticsHandler(req: Request, res: Response): Promise<void> {
  const query = req.valid!.query as AnalyticsQuery;
  const { data, error } = await adminClient.rpc("admin_analytics", {
    _from: query.from,
    _to: query.to,
    _bucket: query.bucket,
    _tz: query.tz,
  });
  if (error) {
    throw error;
  }
  ok(res, data);
}

export async function getIntegrationsHandler(req: Request, res: Response): Promise<void> {
  const { check } = req.valid!.query as IntegrationsQuery;
  ok(res, await getIntegrationsReport(check));
}

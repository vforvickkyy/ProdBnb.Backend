import { Request, Response } from "express";
import { callerHasAdminPermission } from "../admin/permissions";
import { created, ok } from "../../utils/respond";
import { LocationIdOnlyParam } from "../media/media.schema";
import {
  createSection,
  deleteSection,
  getSection,
  listSectionMedia,
  listSections,
  updateSection,
} from "./sections.service";
import { CreateSectionInput, LocationSectionParams, UpdateSectionInput } from "./sections.schema";

// Admin Console: "may this caller act as an administrator here" is a team-role permission,
// not bare admin-role membership -- see src/modules/admin/permissions.ts.
async function isCallerAdmin(req: Request): Promise<boolean> {
  return callerHasAdminPermission(req, "locations.moderate");
}

export async function getSections(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdOnlyParam;
  ok(res, await listSections(req.supabase!, id));
}

export async function getSectionDetail(req: Request, res: Response): Promise<void> {
  const { id, sectionId } = req.valid!.params as LocationSectionParams;
  ok(res, await getSection(req.supabase!, id, sectionId));
}

export async function getSectionMedia(req: Request, res: Response): Promise<void> {
  const { id, sectionId } = req.valid!.params as LocationSectionParams;
  ok(res, await listSectionMedia(req.supabase!, id, sectionId));
}

export async function postSection(req: Request, res: Response): Promise<void> {
  const { id } = req.valid!.params as LocationIdOnlyParam;
  const input = req.valid!.body as CreateSectionInput;
  const isAdmin = await isCallerAdmin(req);
  created(res, await createSection(req.supabase!, req.user!.id, isAdmin, id, input));
}

export async function patchSection(req: Request, res: Response): Promise<void> {
  const { id, sectionId } = req.valid!.params as LocationSectionParams;
  const input = req.valid!.body as UpdateSectionInput;
  const isAdmin = await isCallerAdmin(req);
  ok(res, await updateSection(req.supabase!, req.user!.id, isAdmin, id, sectionId, input));
}

export async function deleteSectionHandler(req: Request, res: Response): Promise<void> {
  const { id, sectionId } = req.valid!.params as LocationSectionParams;
  const isAdmin = await isCallerAdmin(req);
  await deleteSection(req.supabase!, req.user!.id, isAdmin, id, sectionId);
  ok(res, { id: sectionId, deleted: true });
}

import { getPreferences, myOnboarding, onboardingStatus, savePreferences, type PreferencesInput } from "./preferences.service";
import { Request, Response } from "express";
import { ok } from "../../utils/respond";
import { listRoles } from "../roles/roles.service";
import { getProfile, listAllProfiles, updateProfile } from "./users.service";
import { ListUsersQuery, UpdateProfileInput } from "./users.schema";

export async function getMe(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const supabase = req.supabase!;

  const [profile, roles, preferences] = await Promise.all([getProfile(supabase, userId), listRoles(supabase, userId), getPreferences(userId)]);

  ok(res, { profile, roles, onboarding: onboardingStatus(profile, preferences) });
}

export async function getMyPreferences(req: Request, res: Response): Promise<void> {
  ok(res, await myOnboarding(req.user!.id));
}

export async function putMyPreferences(req: Request, res: Response): Promise<void> {
  ok(res, await savePreferences(req.user!.id, req.valid!.body as PreferencesInput));
}

export async function patchMe(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const supabase = req.supabase!;
  const patch = req.valid!.body as UpdateProfileInput;

  const profile = await updateProfile(supabase, userId, patch);

  ok(res, { profile });
}

export async function listUsers(req: Request, res: Response): Promise<void> {
  const supabase = req.supabase!;
  const { page, pageSize, search, role, status } = req.valid!.query as ListUsersQuery;

  const { data, total } = await listAllProfiles(supabase, page, pageSize, { search, role, status });

  ok(res, data, 200, { page, pageSize, total });
}

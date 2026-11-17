import { z } from "zod";
import { ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { professionSchema } from "../outreach/outreach.schema";

/**
 * Onboarding answers (user_preferences). Three answers are required before someone is "set up":
 * their name, a mobile number (both on the profile) and what they do. The rest (cities, what they
 * shoot, the kinds of places they like, how they heard of us) is optional and can be finished later.
 * Nothing in the platform is blocked on this; the website uses it to welcome new people.
 */

export const preferencesSchema = z
  .object({
    professions: z.array(professionSchema).max(5).optional(),
    company: z.string().trim().max(120).nullable().optional(),
    cities: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
    use_case_ids: z.array(z.string().uuid()).max(10).optional(),
    category_ids: z.array(z.string().uuid()).max(10).optional(),
    heard_from: z.enum(["search", "social", "friend", "event", "press", "other"]).nullable().optional(),
    new_listing_alerts: z.boolean().optional(),
    /** Finish onboarding (also when the optional steps were skipped). Needs the basics. */
    complete: z.boolean().optional(),
  })
  .strict();
export type PreferencesInput = z.infer<typeof preferencesSchema>;

export interface Preferences {
  professions: string[];
  company: string | null;
  cities: string[];
  use_case_ids: string[];
  category_ids: string[];
  heard_from: string | null;
  new_listing_alerts: boolean;
  onboarding_completed_at: string | null;
}

export interface OnboardingStatus {
  /** Name, mobile and what they do are all given. */
  basics_done: boolean;
  /** Which of those are still missing: "name", "mobile", "profession". */
  missing: ("name" | "mobile" | "profession")[];
  /** They finished (or skipped) the optional steps too. */
  completed: boolean;
}

const COLUMNS = "professions, company, cities, use_case_ids, category_ids, heard_from, new_listing_alerts, onboarding_completed_at";
const EMPTY: Preferences = { professions: [], company: null, cities: [], use_case_ids: [], category_ids: [], heard_from: null, new_listing_alerts: true, onboarding_completed_at: null };

export async function getPreferences(userId: string): Promise<Preferences> {
  const { data, error } = await adminClient.from("user_preferences").select(COLUMNS).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return (data as Preferences | null) ?? EMPTY;
}

export function onboardingStatus(profile: { first_name: string | null; phone: string | null }, prefs: Preferences): OnboardingStatus {
  const missing: OnboardingStatus["missing"] = [];
  if (!profile.first_name?.trim()) missing.push("name");
  if (!profile.phone?.trim()) missing.push("mobile");
  if (prefs.professions.length === 0) missing.push("profession");
  return { basics_done: missing.length === 0, missing, completed: Boolean(prefs.onboarding_completed_at) && missing.length === 0 };
}

async function profileOf(userId: string): Promise<{ first_name: string | null; phone: string | null }> {
  const { data, error } = await adminClient.from("profiles").select("first_name, phone").eq("id", userId).single();
  if (error) throw error;
  return data as { first_name: string | null; phone: string | null };
}

export async function myOnboarding(userId: string): Promise<{ preferences: Preferences; onboarding: OnboardingStatus }> {
  const [profile, preferences] = await Promise.all([profileOf(userId), getPreferences(userId)]);
  return { preferences, onboarding: onboardingStatus(profile, preferences) };
}

const tidyCities = (cities: string[]) => {
  const seen = new Set<string>();
  return cities
    .map((c) => c.trim().replace(/\s+/g, " "))
    .filter((c) => c && !seen.has(c.toLowerCase()) && seen.add(c.toLowerCase()));
};

export async function savePreferences(userId: string, input: PreferencesInput): Promise<{ preferences: Preferences; onboarding: OnboardingStatus }> {
  const { complete, ...fields } = input;
  const current = await getPreferences(userId);
  const next: Record<string, unknown> = { ...fields };
  if (fields.cities) next.cities = tidyCities(fields.cities);
  if (fields.professions) next.professions = [...new Set(fields.professions)];
  if (fields.company !== undefined) next.company = fields.company?.trim() || null;

  for (const [ids, table] of [
    [fields.use_case_ids, "use_cases"],
    [fields.category_ids, "categories"],
  ] as const) {
    if (ids?.length) {
      const { data } = await adminClient.from(table).select("id").in("id", ids);
      if ((data ?? []).length !== new Set(ids).size) throw new ValidationError("Some of those choices don't exist any more. Refresh and try again.");
    }
  }

  if (complete) {
    const profile = await profileOf(userId);
    const status = onboardingStatus(profile, { ...current, ...(next as Partial<Preferences>) });
    if (!status.basics_done) {
      const words = { name: "your name", mobile: "your mobile number", profession: "what you do" };
      throw new ValidationError(`Add ${status.missing.map((m) => words[m]).join(" and ")} first.`);
    }
    next.onboarding_completed_at = current.onboarding_completed_at ?? new Date().toISOString();
  }

  const { error } = await adminClient.from("user_preferences").upsert({ user_id: userId, ...next }, { onConflict: "user_id" });
  if (error) throw error;
  return myOnboarding(userId);
}

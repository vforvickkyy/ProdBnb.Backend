import { ConflictError, NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import type { CreateTemplateInput, UpdateTemplateInput } from "./outreach.schema";
import { checkVariables, PROFESSION_LABEL } from "./templating";

export interface NotificationTemplate {
  id: string;
  name: string;
  category: "new_listing" | "new_offer" | "casual" | "reminder" | "host" | "custom";
  description: string | null;
  needs: "listing" | "offer" | null;
  title: string;
  body: string;
  email_subject: string | null;
  email_body: string | null;
  channels: ("in_app" | "push" | "email")[];
  email_design: "plain" | "spotlight" | "collection" | "offer" | "news";
  email_heading: string | null;
  email_image_url: string | null;
  email_button_label: string | null;
  is_builtin: boolean;
  created_at: string;
  updated_at: string;
  uses: number;
}

const COLUMNS =
  "id, name, category, description, needs, title, body, email_subject, email_body, channels, email_design, email_heading, email_image_url, email_button_label, is_builtin, created_at, updated_at";

/** Variables must match what the template needs picked: listing variables need `needs: listing`. */
function checkTemplate(t: { title: string; body: string; email_subject?: string | null; email_body?: string | null; email_heading?: string | null; email_button_label?: string | null; needs?: string | null }) {
  checkVariables([t.title, t.body, t.email_subject, t.email_body, t.email_heading, t.email_button_label], { listing: t.needs === "listing", offer: t.needs === "offer" });
}

async function usesOf(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const { data } = await adminClient.from("notification_campaigns").select("template_id").in("template_id", ids);
  for (const r of (data ?? []) as { template_id: string }[]) out.set(r.template_id, (out.get(r.template_id) ?? 0) + 1);
  return out;
}

export async function listTemplates(): Promise<NotificationTemplate[]> {
  const { data, error } = await adminClient.from("notification_templates").select(COLUMNS).order("is_builtin", { ascending: false }).order("created_at", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as Omit<NotificationTemplate, "uses">[];
  const uses = await usesOf(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, uses: uses.get(r.id) ?? 0 }));
}

export async function getTemplate(id: string): Promise<NotificationTemplate> {
  const { data, error } = await adminClient.from("notification_templates").select(COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError("Template not found.");
  return { ...(data as Omit<NotificationTemplate, "uses">), uses: (await usesOf([id])).get(id) ?? 0 };
}

export async function createTemplate(actorId: string, input: CreateTemplateInput): Promise<NotificationTemplate> {
  checkTemplate(input);
  const { data, error } = await adminClient
    .from("notification_templates")
    .insert({ ...input, description: input.description ?? null, needs: input.needs ?? null, email_subject: input.email_subject ?? null, email_body: input.email_body ?? null, created_by: actorId, updated_by: actorId })
    .select("id")
    .single();
  if (error) throw error;
  return getTemplate((data as { id: string }).id);
}

export async function updateTemplate(actorId: string, id: string, input: UpdateTemplateInput): Promise<NotificationTemplate> {
  const current = await getTemplate(id);
  const next = { ...current, ...input };
  if (next.channels.includes("email") && (!next.email_subject || !next.email_body)) throw new ValidationError("Email needs a subject and a body.");
  checkTemplate(next);
  const { error } = await adminClient.from("notification_templates").update({ ...input, updated_by: actorId }).eq("id", id);
  if (error) throw error;
  return getTemplate(id);
}

export async function deleteTemplate(id: string): Promise<NotificationTemplate> {
  const t = await getTemplate(id);
  if (t.is_builtin) throw new ConflictError("Built-in templates can be edited but not deleted.");
  const { error } = await adminClient.from("notification_templates").delete().eq("id", id);
  if (error) throw error;
  return t;
}

/** Choices for the "segment" audience, with how many people each one reaches. */
export async function audienceOptions() {
  const [{ data: prefs, error }, { data: profiles, error: e2 }, { data: useCases, error: e3 }] = await Promise.all([
    adminClient.from("user_preferences").select("professions, cities, use_case_ids").limit(50_000),
    adminClient.from("profiles").select("address_city").not("address_city", "is", null).eq("status", "active").limit(50_000),
    adminClient.from("use_cases").select("id, name").order("name"),
  ]);
  if (error) throw error;
  if (e2) throw e2;
  if (e3) throw e3;
  const rows = (prefs ?? []) as { professions: string[]; cities: string[]; use_case_ids: string[] }[];
  const profCount = new Map<string, number>();
  const caseCount = new Map<string, number>();
  const cityCount = new Map<string, { name: string; count: number }>();
  const addCity = (c: string | null | undefined) => {
    const name = c?.trim();
    if (!name) return;
    const key = name.toLowerCase();
    const e = cityCount.get(key) ?? { name, count: 0 };
    e.count++;
    cityCount.set(key, e);
  };
  for (const r of rows) {
    for (const p of r.professions ?? []) profCount.set(p, (profCount.get(p) ?? 0) + 1);
    for (const u of r.use_case_ids ?? []) caseCount.set(u, (caseCount.get(u) ?? 0) + 1);
    for (const c of r.cities ?? []) addCity(c);
  }
  for (const p of (profiles ?? []) as { address_city: string | null }[]) addCity(p.address_city);
  return {
    professions: Object.entries(PROFESSION_LABEL).map(([value, label]) => ({ value, label, count: profCount.get(value) ?? 0 })),
    cities: [...cityCount.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 100),
    use_cases: ((useCases ?? []) as { id: string; name: string }[]).map((u) => ({ id: u.id, name: u.name, count: caseCount.get(u.id) ?? 0 })),
    onboarded: rows.filter((r) => (r.professions ?? []).length > 0).length,
  };
}

import { ConflictError, NotFoundError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { writeAuditLog } from "../admin/audit.service";
import { CreatePageInput, PagePlacement, UpdatePageInput } from "./content.schema";

/**
 * Website pages (About, Contact, Privacy, Terms, Refund policy...). Stored in `site_pages`
 * (service role only); the public routes serve published ones.
 *
 * Body text is Markdown and may use {{brand}} and {{support_email}}, which the website fills in so
 * the product name is never hardcoded in content.
 */

export interface SitePage {
  id: string;
  slug: string;
  title: string;
  body: string;
  placement: PagePlacement;
  position: number;
  is_published: boolean;
  needs_review: boolean;
  /** Bracketed placeholders still in the text, e.g. "[Company legal name]". */
  placeholders: string[];
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicPageSummary {
  slug: string;
  title: string;
  placement: PagePlacement;
  position: number;
  updated_at: string;
}

export interface PublicPage extends PublicPageSummary {
  body: string;
}

const COLUMNS = "id, slug, title, body, placement, position, is_published, needs_review, updated_by, created_at, updated_at";

type Row = Omit<SitePage, "placeholders">;

/**
 * "[Company legal name]"-style placeholders left in seeded drafts. Markdown links ("[text](url)")
 * and checkboxes are not placeholders.
 */
export function findPlaceholders(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/\[([^\]\n]{2,80})\](?!\()/g)) {
    const inner = match[1]!.trim();
    if (inner === "x" || inner === " ") continue;
    found.add(`[${inner}]`);
  }
  return [...found];
}

function toPage(row: Row): SitePage {
  return { ...row, placeholders: findPlaceholders(row.body) };
}

function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

export async function listPages(): Promise<SitePage[]> {
  const { data, error } = await adminClient.from("site_pages").select(COLUMNS).order("placement").order("position").order("title");
  if (error) throw error;
  return ((data ?? []) as Row[]).map(toPage);
}

export async function getPage(id: string): Promise<SitePage> {
  const { data, error } = await adminClient.from("site_pages").select(COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError("Page not found.");
  return toPage(data as Row);
}

export async function pageSlugExists(slug: string): Promise<boolean> {
  const { data, error } = await adminClient.from("site_pages").select("id").eq("slug", slug).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function createPage(actorId: string, input: CreatePageInput): Promise<SitePage> {
  let position = input.position;
  if (position === undefined) {
    const { data: last, error: lastError } = await adminClient
      .from("site_pages")
      .select("position")
      .eq("placement", input.placement)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastError) throw lastError;
    position = (last?.position ?? 0) + 10;
  }

  const { data, error } = await adminClient
    .from("site_pages")
    .insert({
      slug: input.slug,
      title: input.title,
      body: input.body,
      placement: input.placement,
      position,
      is_published: input.is_published,
      updated_by: actorId,
    })
    .select(COLUMNS)
    .single();
  if (isUniqueViolation(error)) throw new ConflictError("Another page already uses that address.");
  if (error) throw error;

  const page = toPage(data as Row);
  await writeAuditLog(actorId, "ADMIN_CREATED_PAGE", "site_page", page.id, input.reason ?? null, {
    slug: page.slug,
    title: page.title,
    is_published: page.is_published,
  });
  return page;
}

export async function updatePage(actorId: string, id: string, input: UpdatePageInput): Promise<SitePage> {
  const before = await getPage(id);
  const { reason, ...patch } = input;

  const { data, error } = await adminClient
    .from("site_pages")
    .update({ ...patch, updated_by: actorId })
    .eq("id", id)
    .select(COLUMNS)
    .single();
  if (isUniqueViolation(error)) throw new ConflictError("Another page already uses that address.");
  if (error) throw error;
  const after = toPage(data as Row);

  // Record what changed, not the full body (which can be long): just that it changed and by how much.
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of ["slug", "title", "placement", "position", "is_published", "needs_review"] as const) {
    if (patch[key] !== undefined && before[key] !== after[key]) changes[key] = { from: before[key], to: after[key] };
  }
  if (patch.body !== undefined && before.body !== after.body) {
    changes.body = { from: `${before.body.length} characters`, to: `${after.body.length} characters` };
  }
  if (Object.keys(changes).length > 0) {
    await writeAuditLog(actorId, "ADMIN_UPDATED_PAGE", "site_page", id, reason ?? null, { slug: after.slug, changes });
  }
  return after;
}

export async function deletePage(actorId: string, id: string, reason?: string | null): Promise<void> {
  const before = await getPage(id);
  const { error } = await adminClient.from("site_pages").delete().eq("id", id);
  if (error) throw error;
  // The page's SEO override has nothing left to describe.
  const { error: seoError } = await adminClient.from("seo_overrides").delete().eq("entity_type", "page").eq("entity_key", before.slug);
  if (seoError) throw seoError;
  await writeAuditLog(actorId, "ADMIN_DELETED_PAGE", "site_page", id, reason ?? null, { slug: before.slug, title: before.title });
}

// Public -----------------------------------------------------------------------------------------

export async function listPublishedPages(): Promise<PublicPageSummary[]> {
  const { data, error } = await adminClient
    .from("site_pages")
    .select("slug, title, placement, position, updated_at")
    .eq("is_published", true)
    .neq("placement", "hidden")
    .order("placement")
    .order("position")
    .order("title");
  if (error) throw error;
  return (data ?? []) as PublicPageSummary[];
}

export async function getPublishedPage(slug: string): Promise<PublicPage> {
  const { data, error } = await adminClient
    .from("site_pages")
    .select("slug, title, body, placement, position, updated_at")
    .eq("slug", slug)
    .eq("is_published", true)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError("Page not found.");
  return data as PublicPage;
}

import { NotFoundError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { writeAuditLog } from "../admin/audit.service";
import { BUILT_IN_SEO_PAGES, SaveSeoInput, SeoEntityType } from "./content.schema";
import { pageSlugExists } from "./pages.service";

/**
 * SEO overrides: an optional title, description, share image and "noindex" for one website page or
 * entity. Absent fields fall back to what the website writes automatically, so an override only
 * ever needs the parts someone actually wants to change.
 */

export interface SeoOverride {
  id: string;
  entity_type: SeoEntityType;
  entity_key: string;
  meta_title: string | null;
  meta_description: string | null;
  og_image_url: string | null;
  noindex: boolean;
  updated_by: string | null;
  updated_at: string;
}

export interface PublicSeo {
  meta_title: string | null;
  meta_description: string | null;
  og_image_url: string | null;
  noindex: boolean;
}

const COLUMNS = "id, entity_type, entity_key, meta_title, meta_description, og_image_url, noindex, updated_by, updated_at";

const ENTITY_TABLE: Record<Exclude<SeoEntityType, "page">, string> = {
  location: "locations",
  collection: "collections",
  use_case: "use_cases",
  category: "categories",
};

async function assertEntityExists(type: SeoEntityType, key: string): Promise<void> {
  if (type === "page") {
    if ((BUILT_IN_SEO_PAGES as readonly string[]).includes(key) || (await pageSlugExists(key))) return;
    throw new NotFoundError("No such website page.");
  }
  const { data, error } = await adminClient.from(ENTITY_TABLE[type]).select("id").eq("id", key).maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError(`No such ${type.replace("_", " ")}.`);
}

export async function listSeoOverrides(type?: SeoEntityType): Promise<SeoOverride[]> {
  let query = adminClient.from("seo_overrides").select(COLUMNS).order("entity_type").order("updated_at", { ascending: false });
  if (type) query = query.eq("entity_type", type);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as SeoOverride[];
}

export async function getSeoOverride(type: SeoEntityType, key: string): Promise<SeoOverride | null> {
  const { data, error } = await adminClient
    .from("seo_overrides")
    .select(COLUMNS)
    .eq("entity_type", type)
    .eq("entity_key", key)
    .maybeSingle();
  if (error) throw error;
  return (data as SeoOverride | null) ?? null;
}

/**
 * Upsert. Fields left out keep their stored value; null clears one. An override left with nothing
 * in it is deleted, so "reset to automatic" is just saving it empty.
 */
export async function saveSeoOverride(actorId: string, type: SeoEntityType, key: string, input: SaveSeoInput): Promise<SeoOverride | null> {
  await assertEntityExists(type, key);
  const before = await getSeoOverride(type, key);
  const next = {
    meta_title: input.meta_title !== undefined ? input.meta_title : (before?.meta_title ?? null),
    meta_description: input.meta_description !== undefined ? input.meta_description : (before?.meta_description ?? null),
    og_image_url: input.og_image_url !== undefined ? input.og_image_url : (before?.og_image_url ?? null),
    noindex: input.noindex !== undefined ? input.noindex : (before?.noindex ?? false),
  };
  const empty = !next.meta_title && !next.meta_description && !next.og_image_url && !next.noindex;

  let after: SeoOverride | null = null;
  if (empty) {
    if (before) {
      const { error } = await adminClient.from("seo_overrides").delete().eq("id", before.id);
      if (error) throw error;
    }
  } else {
    const { data, error } = await adminClient
      .from("seo_overrides")
      .upsert({ entity_type: type, entity_key: key, ...next, updated_by: actorId }, { onConflict: "entity_type,entity_key" })
      .select(COLUMNS)
      .single();
    if (error) throw error;
    after = data as SeoOverride;
  }

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of ["meta_title", "meta_description", "og_image_url", "noindex"] as const) {
    const from = before?.[field] ?? (field === "noindex" ? false : null);
    const to = next[field];
    if (from !== to) changes[field] = { from, to };
  }
  const targetId = after?.id ?? before?.id;
  if (targetId && Object.keys(changes).length > 0) {
    await writeAuditLog(actorId, "ADMIN_UPDATED_SEO", "seo", targetId, input.reason ?? null, {
      entity_type: type,
      entity_key: key,
      reset: empty,
      changes,
    });
  }
  return after;
}

export async function getPublicSeo(type: SeoEntityType, key: string): Promise<PublicSeo | null> {
  const row = await getSeoOverride(type, key);
  if (!row) return null;
  return { meta_title: row.meta_title, meta_description: row.meta_description, og_image_url: row.og_image_url, noindex: row.noindex };
}

/** Everything marked noindex -- the website leaves these out of its sitemap. */
export async function listNoindex(): Promise<{ entity_type: SeoEntityType; entity_key: string }[]> {
  const { data, error } = await adminClient.from("seo_overrides").select("entity_type, entity_key").eq("noindex", true);
  if (error) throw error;
  return (data ?? []) as { entity_type: SeoEntityType; entity_key: string }[];
}

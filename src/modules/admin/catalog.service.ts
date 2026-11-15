import { ConflictError, NotFoundError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { writeAuditLog } from "./audit.service";

/**
 * Catalog management (Admin Console) -- the three lookup tables behind every listing's
 * categories / amenities / use-cases. Until now a new option was "a one-line insert with the
 * service-role key" (docs/DATABASE.md, Phase 2); this is that, behind the API, audited.
 *
 * Deletion of an option still attached to a listing is REFUSED rather than cascaded: the join
 * tables' FKs cascade, so a delete would silently strip the tag from every listing that has it.
 * Rename instead, or detach it from those listings first.
 */
export const CATALOG_KINDS = ["categories", "amenities", "use-cases"] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

const TABLES: Record<CatalogKind, { table: "categories" | "amenities" | "use_cases"; join: string; fk: string }> = {
  categories: { table: "categories", join: "location_categories", fk: "category_id" },
  amenities: { table: "amenities", join: "location_amenities", fk: "amenity_id" },
  "use-cases": { table: "use_cases", join: "location_use_cases", fk: "use_case_id" },
};

export interface AdminCatalogItem {
  id: string;
  name: string;
  created_at: string;
  usage_count: number;
}

const UNIQUE_VIOLATION = "23505";

async function usageCount(kind: CatalogKind, id: string): Promise<number> {
  const { join, fk } = TABLES[kind];
  const { count, error } = await adminClient.from(join).select("location_id", { count: "exact", head: true }).eq(fk, id);
  if (error) {
    throw error;
  }
  return count ?? 0;
}

export async function listCatalog(kind: CatalogKind): Promise<AdminCatalogItem[]> {
  const { table, join, fk } = TABLES[kind];
  const [{ data: items, error }, { data: links, error: linkError }] = await Promise.all([
    adminClient.from(table).select("id, name, created_at").order("name"),
    adminClient.from(join).select(fk),
  ]);
  if (error) {
    throw error;
  }
  if (linkError) {
    throw linkError;
  }
  const counts = new Map<string, number>();
  for (const link of (links ?? []) as unknown as Record<string, string>[]) {
    const id = link[fk];
    if (id) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return (items ?? []).map((item) => ({ ...item, usage_count: counts.get(item.id) ?? 0 }));
}

async function getItem(kind: CatalogKind, id: string): Promise<{ id: string; name: string; created_at: string }> {
  const { data, error } = await adminClient.from(TABLES[kind].table).select("id, name, created_at").eq("id", id).maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Catalog item not found.");
  }
  return data;
}

export async function createCatalogItem(actorId: string, kind: CatalogKind, name: string): Promise<AdminCatalogItem> {
  const { data, error } = await adminClient.from(TABLES[kind].table).insert({ name }).select("id, name, created_at").single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      throw new ConflictError(`"${name}" already exists.`);
    }
    throw error;
  }
  await writeAuditLog(actorId, "ADMIN_CREATED_CATALOG_ITEM", "catalog_item", data.id, null, { kind, name });
  return { ...data, usage_count: 0 };
}

export async function renameCatalogItem(actorId: string, kind: CatalogKind, id: string, name: string): Promise<AdminCatalogItem> {
  const before = await getItem(kind, id);
  const { data, error } = await adminClient.from(TABLES[kind].table).update({ name }).eq("id", id).select("id, name, created_at").single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      throw new ConflictError(`"${name}" already exists.`);
    }
    throw error;
  }
  await writeAuditLog(actorId, "ADMIN_UPDATED_CATALOG_ITEM", "catalog_item", id, null, {
    kind,
    previous_name: before.name,
    new_name: name,
  });
  return { ...data, usage_count: await usageCount(kind, id) };
}

export async function deleteCatalogItem(actorId: string, kind: CatalogKind, id: string): Promise<void> {
  const item = await getItem(kind, id);
  const used = await usageCount(kind, id);
  if (used > 0) {
    throw new ConflictError(
      `"${item.name}" is used by ${used} listing${used === 1 ? "" : "s"}. Rename it, or remove it from those listings first.`
    );
  }
  const { error } = await adminClient.from(TABLES[kind].table).delete().eq("id", id);
  if (error) {
    throw error;
  }
  await writeAuditLog(actorId, "ADMIN_DELETED_CATALOG_ITEM", "catalog_item", id, null, { kind, name: item.name });
}

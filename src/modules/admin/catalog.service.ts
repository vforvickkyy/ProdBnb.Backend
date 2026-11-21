import { ConflictError, NotFoundError, ValidationError } from "../../errors/AppError";
import { CoverUploadAuthorization, CoverUploadRequest, discardCover, presignCoverUpload, verifyUploadedCover } from "../../lib/coverUploads";
import { publicUrlFor } from "../../lib/r2";
import { adminClient } from "../../lib/supabase";
import { getLocationCards, LocationCard } from "../locations/locations.service";
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
  description: string | null;
  cover_url: string | null;
  created_at: string;
  usage_count: number;
  /** Amenities only: a tick-box amenity, or an "allowed here" rule; and where it sits on the listing. */
  kind?: "amenity" | "rule";
  group_name?: string | null;
  position?: number;
}

const BASE_COLUMNS = "id, name, description, cover_storage_key, created_at";
/** Amenities carry a kind, a group and an order as well. */
const columnsFor = (kind: CatalogKind): string => (kind === "amenities" ? `${BASE_COLUMNS}, kind, group_name, position` : BASE_COLUMNS);

interface CatalogRow {
  id: string;
  name: string;
  description: string | null;
  cover_storage_key: string | null;
  created_at: string;
  kind?: "amenity" | "rule";
  group_name?: string | null;
  position?: number;
}

/** The extra fields an amenity can be created or edited with. */
export interface AmenityExtras {
  kind?: "amenity" | "rule";
  group_name?: string | null;
  position?: number;
}

function toItem(row: CatalogRow, usage: number): AdminCatalogItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    cover_url: row.cover_storage_key ? publicUrlFor(row.cover_storage_key) : null,
    created_at: row.created_at,
    usage_count: usage,
    ...(row.kind !== undefined ? { kind: row.kind, group_name: row.group_name ?? null, position: row.position ?? 0 } : {}),
  };
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
    kind === "amenities"
      ? adminClient.from(table).select(columnsFor(kind)).order("kind").order("position").order("name")
      : adminClient.from(table).select(columnsFor(kind)).order("name"),
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
  return ((items ?? []) as unknown as CatalogRow[]).map((item) => toItem(item, counts.get(item.id) ?? 0));
}

async function getItem(kind: CatalogKind, id: string): Promise<CatalogRow> {
  const { data, error } = await adminClient.from(TABLES[kind].table).select(columnsFor(kind)).eq("id", id).maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Catalog item not found.");
  }
  return data as unknown as CatalogRow;
}

export async function createCatalogItem(
  actorId: string,
  kind: CatalogKind,
  name: string,
  description: string | null = null,
  extras: AmenityExtras = {}
): Promise<AdminCatalogItem> {
  const { data, error } = await adminClient
    .from(TABLES[kind].table)
    .insert({ name, description, ...(kind === "amenities" ? extras : {}) })
    .select(columnsFor(kind))
    .single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      throw new ConflictError(`"${name}" already exists.`);
    }
    throw error;
  }
  await writeAuditLog(actorId, "ADMIN_CREATED_CATALOG_ITEM", "catalog_item", (data as unknown as CatalogRow).id, null, { kind, name });
  return toItem(data as unknown as CatalogRow, 0);
}

export async function renameCatalogItem(
  actorId: string,
  kind: CatalogKind,
  id: string,
  patch: { name?: string; description?: string | null } & AmenityExtras
): Promise<AdminCatalogItem> {
  const before = await getItem(kind, id);
  // kind / group / position only exist on amenities.
  const { kind: amenityKind, group_name: groupName, position, ...plain } = patch;
  const update = kind === "amenities" ? patch : plain;
  const { data, error } = await adminClient.from(TABLES[kind].table).update(update).eq("id", id).select(columnsFor(kind)).single();
  void amenityKind; void groupName; void position;
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      throw new ConflictError(`"${patch.name ?? before.name}" already exists.`);
    }
    throw error;
  }
  await writeAuditLog(actorId, "ADMIN_UPDATED_CATALOG_ITEM", "catalog_item", id, null, {
    kind,
    previous_name: before.name,
    new_name: patch.name ?? before.name,
    description_changed: patch.description !== undefined,
  });
  return toItem(data as unknown as CatalogRow, await usageCount(kind, id));
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
  await discardCover(item.cover_storage_key);
  await writeAuditLog(actorId, "ADMIN_DELETED_CATALOG_ITEM", "catalog_item", id, null, { kind, name: item.name });
}

// ============================================================================
// Admin Console 2 -- cover images
// ============================================================================

function coverPrefix(kind: CatalogKind, id: string): string {
  return `catalog/${kind}/${id}`;
}

export async function requestCatalogCoverUpload(
  kind: CatalogKind,
  id: string,
  input: CoverUploadRequest
): Promise<CoverUploadAuthorization> {
  await getItem(kind, id);
  return presignCoverUpload(coverPrefix(kind, id), input);
}

export async function setCatalogCover(actorId: string, kind: CatalogKind, id: string, storageKey: string): Promise<AdminCatalogItem> {
  const before = await getItem(kind, id);
  await verifyUploadedCover(coverPrefix(kind, id), storageKey);
  const { data, error } = await adminClient
    .from(TABLES[kind].table)
    .update({ cover_storage_key: storageKey })
    .eq("id", id)
    .select(columnsFor(kind))
    .single();
  if (error) {
    throw error;
  }
  if (before.cover_storage_key && before.cover_storage_key !== storageKey) {
    await discardCover(before.cover_storage_key);
  }
  await writeAuditLog(actorId, "ADMIN_UPDATED_CATALOG_COVER", "catalog_item", id, null, { kind, change: "set" });
  return toItem(data as unknown as CatalogRow, await usageCount(kind, id));
}

export async function removeCatalogCover(actorId: string, kind: CatalogKind, id: string): Promise<AdminCatalogItem> {
  const before = await getItem(kind, id);
  const { data, error } = await adminClient
    .from(TABLES[kind].table)
    .update({ cover_storage_key: null })
    .eq("id", id)
    .select(columnsFor(kind))
    .single();
  if (error) {
    throw error;
  }
  await discardCover(before.cover_storage_key);
  await writeAuditLog(actorId, "ADMIN_UPDATED_CATALOG_COVER", "catalog_item", id, null, { kind, change: "removed" });
  return toItem(data as unknown as CatalogRow, await usageCount(kind, id));
}

// ============================================================================
// Admin Console 2 -- which listings carry this category / amenity / use case
// ============================================================================

export interface CatalogListingsPage {
  data: LocationCard[];
  total: number;
}

export async function listCatalogListings(
  kind: CatalogKind,
  id: string,
  page: number,
  pageSize: number
): Promise<CatalogListingsPage> {
  await getItem(kind, id);
  const { join, fk } = TABLES[kind];
  const from = (page - 1) * pageSize;
  const { data, error, count } = await adminClient
    .from(join)
    .select("location_id", { count: "exact" })
    .eq(fk, id)
    .order("location_id")
    .range(from, from + pageSize - 1);
  if (error) {
    throw error;
  }
  const ids = ((data ?? []) as { location_id: string }[]).map((r) => r.location_id);
  return { data: await getLocationCards(adminClient, ids), total: count ?? 0 };
}

export async function addCatalogListings(
  actorId: string,
  kind: CatalogKind,
  id: string,
  locationIds: string[]
): Promise<{ added: number }> {
  const item = await getItem(kind, id);
  const { join, fk } = TABLES[kind];
  const { data: existing, error: existingError } = await adminClient.from("locations").select("id").in("id", locationIds);
  if (existingError) {
    throw existingError;
  }
  const valid = new Set(((existing ?? []) as { id: string }[]).map((l) => l.id));
  const missing = locationIds.filter((l) => !valid.has(l));
  if (missing.length > 0) {
    throw new ValidationError(`Listing not found: ${missing.join(", ")}`);
  }

  const { data, error } = await adminClient
    .from(join)
    .upsert(
      locationIds.map((locationId) => ({ location_id: locationId, [fk]: id })),
      { onConflict: `location_id,${fk}`, ignoreDuplicates: true }
    )
    .select("location_id");
  if (error) {
    throw error;
  }
  const added = (data ?? []).length;
  await writeAuditLog(actorId, "ADMIN_UPDATED_CATALOG_LISTINGS", "catalog_item", id, null, {
    kind,
    name: item.name,
    added: locationIds,
  });
  return { added };
}

export async function removeCatalogListing(actorId: string, kind: CatalogKind, id: string, locationId: string): Promise<void> {
  const item = await getItem(kind, id);
  const { join, fk } = TABLES[kind];
  const { data, error } = await adminClient.from(join).delete().eq(fk, id).eq("location_id", locationId).select("location_id");
  if (error) {
    throw error;
  }
  if (!data || data.length === 0) {
    throw new NotFoundError("That listing is not in this catalog item.");
  }
  await writeAuditLog(actorId, "ADMIN_UPDATED_CATALOG_LISTINGS", "catalog_item", id, null, {
    kind,
    name: item.name,
    removed: [locationId],
  });
}

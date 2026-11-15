import { SupabaseClient } from "@supabase/supabase-js";
import { ConflictError, NotFoundError, ValidationError } from "../../errors/AppError";
import { CoverUploadAuthorization, CoverUploadRequest, discardCover, presignCoverUpload, verifyUploadedCover } from "../../lib/coverUploads";
import { publicUrlFor } from "../../lib/r2";
import { adminClient } from "../../lib/supabase";
import { writeAuditLog } from "../admin/audit.service";
import { getLocationCards, LocationCard } from "../locations/locations.service";

/**
 * Admin Console 2: curated collections ("Beach villas in Goa") -- see the
 * 20261115150000_catalog_covers_collections migration.
 *
 * Admin reads/writes use the service-role client (the routes are permission-gated). Public reads
 * use the caller's own client, so RLS -- not this file -- decides what is public: an unpublished
 * collection does not exist for the public, and an unpublished listing never appears inside a
 * published one.
 */

const COLUMNS = "id, title, slug, description, cover_storage_key, is_published, position, created_at, updated_at";
const UNIQUE_VIOLATION = "23505";

interface CollectionRow {
  id: string;
  title: string;
  slug: string;
  description: string;
  cover_storage_key: string | null;
  is_published: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface CollectionSummary {
  id: string;
  title: string;
  slug: string;
  description: string;
  cover_url: string | null;
  is_published: boolean;
  position: number;
  listing_count: number;
  created_at: string;
  updated_at: string;
}

export interface CollectionDetail extends CollectionSummary {
  listings: LocationCard[];
}

function toSummary(row: CollectionRow, count: number): CollectionSummary {
  const { cover_storage_key, ...rest } = row;
  return { ...rest, cover_url: cover_storage_key ? publicUrlFor(cover_storage_key) : null, listing_count: count };
}

async function counts(client: SupabaseClient, ids: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (ids.length === 0) {
    return result;
  }
  const { data, error } = await client.from("collection_locations").select("collection_id").in("collection_id", ids);
  if (error) {
    throw error;
  }
  for (const row of (data ?? []) as { collection_id: string }[]) {
    result.set(row.collection_id, (result.get(row.collection_id) ?? 0) + 1);
  }
  return result;
}

async function getRow(id: string): Promise<CollectionRow> {
  const { data, error } = await adminClient.from("collections").select(COLUMNS).eq("id", id).maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Collection not found.");
  }
  return data as CollectionRow;
}

async function orderedLocationIds(client: SupabaseClient, collectionId: string): Promise<string[]> {
  const { data, error } = await client
    .from("collection_locations")
    .select("location_id, position, created_at")
    .eq("collection_id", collectionId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    throw error;
  }
  return ((data ?? []) as { location_id: string }[]).map((r) => r.location_id);
}

// ---------------------------------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------------------------------

export async function listCollectionsForAdmin(): Promise<CollectionSummary[]> {
  const { data, error } = await adminClient
    .from("collections")
    .select(COLUMNS)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    throw error;
  }
  const rows = (data ?? []) as CollectionRow[];
  const c = await counts(adminClient, rows.map((r) => r.id));
  return rows.map((r) => toSummary(r, c.get(r.id) ?? 0));
}

export async function getCollectionForAdmin(id: string): Promise<CollectionDetail> {
  const row = await getRow(id);
  const ids = await orderedLocationIds(adminClient, id);
  return { ...toSummary(row, ids.length), listings: await getLocationCards(adminClient, ids) };
}

export interface CollectionInput {
  title?: string;
  slug?: string;
  description?: string;
  is_published?: boolean;
  position?: number;
}

function translate(error: { code?: string }): never {
  if (error.code === UNIQUE_VIOLATION) {
    throw new ConflictError("Another collection already uses that slug.");
  }
  throw error;
}

export async function createCollection(actorId: string, input: Required<Pick<CollectionInput, "title" | "slug">> & CollectionInput) {
  const { data, error } = await adminClient
    .from("collections")
    .insert({ ...input, created_by: actorId, updated_by: actorId })
    .select(COLUMNS)
    .single();
  if (error) {
    translate(error);
  }
  const row = data as CollectionRow;
  await writeAuditLog(actorId, "ADMIN_CREATED_COLLECTION", "collection", row.id, null, { title: row.title, slug: row.slug });
  return getCollectionForAdmin(row.id);
}

export async function updateCollection(actorId: string, id: string, input: CollectionInput): Promise<CollectionDetail> {
  const before = await getRow(id);
  const { error } = await adminClient
    .from("collections")
    .update({ ...input, updated_by: actorId })
    .eq("id", id);
  if (error) {
    translate(error);
  }
  await writeAuditLog(actorId, "ADMIN_UPDATED_COLLECTION", "collection", id, null, {
    fields: Object.keys(input),
    ...(input.is_published !== undefined && input.is_published !== before.is_published
      ? { published: input.is_published }
      : {}),
  });
  return getCollectionForAdmin(id);
}

export async function deleteCollection(actorId: string, id: string): Promise<void> {
  const row = await getRow(id);
  const { error } = await adminClient.from("collections").delete().eq("id", id);
  if (error) {
    throw error;
  }
  await discardCover(row.cover_storage_key);
  await writeAuditLog(actorId, "ADMIN_DELETED_COLLECTION", "collection", id, null, { title: row.title, slug: row.slug });
}

export async function requestCollectionCoverUpload(id: string, input: CoverUploadRequest): Promise<CoverUploadAuthorization> {
  await getRow(id);
  return presignCoverUpload(`collections/${id}`, input);
}

export async function setCollectionCover(actorId: string, id: string, storageKey: string | null): Promise<CollectionDetail> {
  const before = await getRow(id);
  if (storageKey) {
    await verifyUploadedCover(`collections/${id}`, storageKey);
  }
  const { error } = await adminClient
    .from("collections")
    .update({ cover_storage_key: storageKey, updated_by: actorId })
    .eq("id", id);
  if (error) {
    throw error;
  }
  if (before.cover_storage_key && before.cover_storage_key !== storageKey) {
    await discardCover(before.cover_storage_key);
  }
  await writeAuditLog(actorId, "ADMIN_UPDATED_COLLECTION", "collection", id, null, {
    fields: ["cover"],
    change: storageKey ? "set" : "removed",
  });
  return getCollectionForAdmin(id);
}

export async function addCollectionListings(actorId: string, id: string, locationIds: string[]): Promise<CollectionDetail> {
  await getRow(id);
  const { data: found, error: findError } = await adminClient.from("locations").select("id").in("id", locationIds);
  if (findError) {
    throw findError;
  }
  const valid = new Set(((found ?? []) as { id: string }[]).map((l) => l.id));
  const missing = locationIds.filter((l) => !valid.has(l));
  if (missing.length > 0) {
    throw new ValidationError(`Listing not found: ${missing.join(", ")}`);
  }

  const existing = await orderedLocationIds(adminClient, id);
  const fresh = locationIds.filter((l) => !existing.includes(l));
  if (fresh.length > 0) {
    const { error } = await adminClient.from("collection_locations").insert(
      fresh.map((locationId, i) => ({
        collection_id: id,
        location_id: locationId,
        position: existing.length + i,
        added_by: actorId,
      }))
    );
    if (error) {
      throw error;
    }
  }
  await writeAuditLog(actorId, "ADMIN_UPDATED_COLLECTION", "collection", id, null, { fields: ["listings"], added: fresh });
  return getCollectionForAdmin(id);
}

export async function removeCollectionListing(actorId: string, id: string, locationId: string): Promise<CollectionDetail> {
  await getRow(id);
  const { data, error } = await adminClient
    .from("collection_locations")
    .delete()
    .eq("collection_id", id)
    .eq("location_id", locationId)
    .select("location_id");
  if (error) {
    throw error;
  }
  if (!data || data.length === 0) {
    throw new NotFoundError("That listing is not in this collection.");
  }
  await writeAuditLog(actorId, "ADMIN_UPDATED_COLLECTION", "collection", id, null, { fields: ["listings"], removed: [locationId] });
  return getCollectionForAdmin(id);
}

/** Whole-list reorder, the same "state the complete order" contract as the media gallery. */
export async function reorderCollectionListings(actorId: string, id: string, orderedIds: string[]): Promise<CollectionDetail> {
  await getRow(id);
  const existing = await orderedLocationIds(adminClient, id);
  if (existing.length !== orderedIds.length || existing.some((l) => !orderedIds.includes(l))) {
    throw new ValidationError("ordered_ids must list exactly the listings currently in the collection.");
  }
  for (const [position, locationId] of orderedIds.entries()) {
    const { error } = await adminClient
      .from("collection_locations")
      .update({ position })
      .eq("collection_id", id)
      .eq("location_id", locationId);
    if (error) {
      throw error;
    }
  }
  await writeAuditLog(actorId, "ADMIN_UPDATED_COLLECTION", "collection", id, null, { fields: ["order"] });
  return getCollectionForAdmin(id);
}

// ---------------------------------------------------------------------------------------------------
// Public (RLS-scoped -- pass the caller's client)
// ---------------------------------------------------------------------------------------------------

export async function listPublishedCollections(client: SupabaseClient): Promise<CollectionSummary[]> {
  const { data, error } = await client
    .from("collections")
    .select(COLUMNS)
    .eq("is_published", true)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    throw error;
  }
  const rows = (data ?? []) as CollectionRow[];
  const c = await counts(client, rows.map((r) => r.id));
  return rows.map((r) => toSummary(r, c.get(r.id) ?? 0));
}

export async function getPublishedCollection(client: SupabaseClient, idOrSlug: string): Promise<CollectionDetail> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  const { data, error } = await client
    .from("collections")
    .select(COLUMNS)
    .eq(isUuid ? "id" : "slug", idOrSlug)
    .eq("is_published", true)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Collection not found.");
  }
  const row = data as CollectionRow;
  const ids = await orderedLocationIds(client, row.id);
  const listings = (await getLocationCards(client, ids)).filter((l) => l.status === "published");
  return { ...toSummary(row, listings.length), listings };
}

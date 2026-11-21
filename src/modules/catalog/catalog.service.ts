import { SupabaseClient } from "@supabase/supabase-js";
import { publicUrlFor } from "../../lib/r2";

export interface CatalogItem {
  id: string;
  name: string;
  /** Admin Console 2 -- additive and nullable; older clients ignore both. */
  description: string | null;
  cover_url: string | null;
  /**
   * Amenities only (additive; older clients ignore them): "amenity" is a tick box under Amenities, "rule" a
   * tick box under "Allowed here". `group_name` and `position` say how they are grouped and ordered.
   */
  kind?: "amenity" | "rule";
  group_name?: string | null;
  position?: number;
}

interface CatalogRow {
  id: string;
  name: string;
  description: string | null;
  cover_storage_key: string | null;
  kind?: "amenity" | "rule";
  group_name?: string | null;
  position?: number;
}

async function listCatalog(supabase: SupabaseClient, table: "categories" | "amenities" | "use_cases"): Promise<CatalogItem[]> {
  const base = "id, name, description, cover_storage_key";
  const { data, error } =
    table === "amenities"
      ? await supabase.from(table).select(`${base}, kind, group_name, position`).order("kind").order("position").order("name")
      : await supabase.from(table).select(base).order("name", { ascending: true });
  if (error) {
    throw error;
  }
  return ((data ?? []) as unknown as CatalogRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    cover_url: row.cover_storage_key ? publicUrlFor(row.cover_storage_key) : null,
    ...(row.kind !== undefined ? { kind: row.kind, group_name: row.group_name ?? null, position: row.position ?? 0 } : {}),
  }));
}

export const listCategories = (supabase: SupabaseClient): Promise<CatalogItem[]> => listCatalog(supabase, "categories");
export const listAmenities = (supabase: SupabaseClient): Promise<CatalogItem[]> => listCatalog(supabase, "amenities");
export const listUseCases = (supabase: SupabaseClient): Promise<CatalogItem[]> => listCatalog(supabase, "use_cases");

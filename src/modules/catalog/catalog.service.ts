import { SupabaseClient } from "@supabase/supabase-js";
import { publicUrlFor } from "../../lib/r2";

export interface CatalogItem {
  id: string;
  name: string;
  /** Admin Console 2 -- additive and nullable; older clients ignore both. */
  description: string | null;
  cover_url: string | null;
}

async function listCatalog(supabase: SupabaseClient, table: "categories" | "amenities" | "use_cases"): Promise<CatalogItem[]> {
  const { data, error } = await supabase
    .from(table)
    .select("id, name, description, cover_storage_key")
    .order("name", { ascending: true });
  if (error) {
    throw error;
  }
  return ((data ?? []) as { id: string; name: string; description: string | null; cover_storage_key: string | null }[]).map(
    (row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      cover_url: row.cover_storage_key ? publicUrlFor(row.cover_storage_key) : null,
    })
  );
}

export const listCategories = (supabase: SupabaseClient): Promise<CatalogItem[]> => listCatalog(supabase, "categories");
export const listAmenities = (supabase: SupabaseClient): Promise<CatalogItem[]> => listCatalog(supabase, "amenities");
export const listUseCases = (supabase: SupabaseClient): Promise<CatalogItem[]> => listCatalog(supabase, "use_cases");

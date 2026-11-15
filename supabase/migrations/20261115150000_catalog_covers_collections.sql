-- Admin Console 2: catalog cover images + curated collections.
--
-- 1. Categories, amenities and use cases gain an optional cover image and a short description,
--    so the apps can render them as visual tiles. Both are nullable and additive: every existing
--    reader (GET /v1/categories etc., the iOS decoders) keeps working, unknown keys are ignored.
--
-- 2. Collections -- curated, ordered sets of listings with a cover ("Beach villas in Goa",
--    "Studios under INR 5,000/hr"). Unlike categories, which a HOST picks for their own listing,
--    a collection is editorial: only admins put listings in it, in an order they choose, and it is
--    invisible until an admin publishes it.
--
-- Cover images live in Cloudflare R2 like every other listing photo; the row stores only the
-- object key (`cover_storage_key`), the API turns it into a public URL.

-- ============================================================================
-- 1. Catalog covers
-- ============================================================================

alter table public.categories
  add column description text check (description is null or char_length(description) <= 500),
  add column cover_storage_key text;

alter table public.amenities
  add column description text check (description is null or char_length(description) <= 500),
  add column cover_storage_key text;

alter table public.use_cases
  add column description text check (description is null or char_length(description) <= 500),
  add column cover_storage_key text;

-- The table-level SELECT grants from 20261115090000 already cover new columns; writes stay
-- service-role only (the Admin API).

-- ============================================================================
-- 2. Collections
-- ============================================================================

create table public.collections (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  slug text not null unique
    check (char_length(slug) between 1 and 80 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text not null default '' check (char_length(description) <= 1000),
  cover_storage_key text,
  is_published boolean not null default false,
  -- Display order of collections relative to each other (lower first).
  position integer not null default 0,
  created_by uuid references public.profiles (id) on delete set null,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.collections is
  'Admin-curated, ordered set of listings with a cover image. Invisible to the public until '
  'is_published; only published listings inside it are ever shown publicly.';

create index collections_published_position_idx on public.collections (is_published, position);

create trigger set_collections_updated_at
  before update on public.collections
  for each row execute function public.set_updated_at();

create table public.collection_locations (
  collection_id uuid not null references public.collections (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  position integer not null default 0,
  added_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (collection_id, location_id)
);

create index collection_locations_location_id_idx on public.collection_locations (location_id);
create index collection_locations_order_idx on public.collection_locations (collection_id, position);

alter table public.collections enable row level security;
alter table public.collection_locations enable row level security;

create policy "collections_select_published"
  on public.collections for select to anon
  using (is_published);

create policy "collections_select_published_or_admin"
  on public.collections for select to authenticated
  using (is_published or public.has_role(auth.uid(), 'admin'));

-- A membership row is public only when BOTH ends are public: a published collection and a
-- published listing. A suspended listing silently drops out of every collection it is in.
create policy "collection_locations_select_public"
  on public.collection_locations for select to anon
  using (
    exists (select 1 from public.collections c where c.id = collection_id and c.is_published)
    and exists (select 1 from public.locations l where l.id = location_id and l.status = 'published')
  );

create policy "collection_locations_select_public_or_admin"
  on public.collection_locations for select to authenticated
  using (
    public.has_role(auth.uid(), 'admin')
    or (
      exists (select 1 from public.collections c where c.id = collection_id and c.is_published)
      and exists (select 1 from public.locations l where l.id = location_id and l.status = 'published')
    )
  );

revoke all on public.collections, public.collection_locations from anon, authenticated;
grant select on public.collections, public.collection_locations to anon, authenticated;
grant select, insert, update, delete on public.collections, public.collection_locations to service_role;

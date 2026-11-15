-- Phase 29-17G: optional GST billing details
--
-- Purely additive. One new table, its RLS and its grants. **`public.profiles` is not touched** --
-- no column added, no policy changed, no grant altered. Nothing about `profiles.phone` changes.
--
-- Scope note: this stores the details a user *may* supply for future invoicing. It does NOT create
-- invoice tables, and nothing here generates or numbers an invoice. When invoices arrive they must
-- **snapshot** these values onto the invoice row rather than joining back to this table -- a
-- historical invoice must never change because the user later edited their GSTIN. That is recorded
-- in docs/PHASE_29_17C_D1... and the 29.17 inspection §13; it is deliberately not built here.

-- ============================================================================
-- user_billing_profiles
--
-- A separate table rather than columns on `profiles`, decided in the 29.17 inspection (§11, D4):
--
--   1. `profiles` is guarded by a *column-level* `GRANT UPDATE (...)` list. Every new writable
--      column must be added to it or the write silently fails RLS -- the trap the Phase 26-MB
--      migration documents at length. A separate table gets one clean table-level grant instead.
--   2. "This user has supplied no billing details" becomes a missing row rather than several
--      ambiguous NULLs.
--   3. Blast radius: a future finance/admin read can be granted here without widening anything on
--      `profiles`, which is embedded (by explicit column list) in `get_host_public_profile` and the
--      admin listing.
--
-- `user_id` is the PRIMARY KEY, which is what enforces **one row per user**. A second insert for
-- the same user is a unique violation, not a duplicate -- no application-level guard needed.
-- ============================================================================

create table public.user_billing_profiles (
  user_id uuid primary key references public.profiles (id) on delete cascade,

  -- Both optional, deliberately. Existing users are not forced to supply anything, and a user may
  -- legitimately have a company name without a GSTIN (unregistered) or neither.
  company_name text,
  gst_number text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Structural GSTIN check only.
  --
  --   27  AAPFU0939F  1  Z  V
  --   │   │           │  │  └─ checksum (mod-36)
  --   │   │           │  └──── literal 'Z'
  --   │   │           └─────── entity number for the PAN within the state
  --   │   └─────────────────── 10-character PAN
  --   └─────────────────────── 2-digit state code
  --
  -- The **checksum is deliberately not computed here**. It is implementation, not a constraint: a
  -- future revision to the algorithm would require a table rewrite, and a CHECK constraint is a
  -- poor place to carry arithmetic. The checksum is enforced in the Zod layer
  -- (`billing.schema.ts`), which is where this codebase consistently puts validation -- the same
  -- split `users.schema.ts` uses for phone and address lengths.
  constraint user_billing_profiles_gstin_format check (
    gst_number is null
    or gst_number ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'
  ),

  -- An empty string is not a value. Clearing a field is expressed as NULL, so "" and NULL can never
  -- both mean "absent" -- the same rule `users.schema.ts` applies to every address part.
  constraint user_billing_profiles_company_name_not_blank check (
    company_name is null or length(btrim(company_name)) > 0
  ),
  constraint user_billing_profiles_company_name_length check (
    company_name is null or length(company_name) <= 200
  )
);

comment on table public.user_billing_profiles is
  'Optional GST/billing details a user may supply for future invoicing. One row per user '
  '(user_id is the primary key). Separate from public.profiles by design -- see the migration '
  'header. Invoices must SNAPSHOT these values, never join to them, so historical invoices do not '
  'change when a user edits their details.';

comment on column public.user_billing_profiles.gst_number is
  'Indian GSTIN, 15 characters, stored uppercase. Structurally validated here; the mod-36 checksum '
  'is validated in the API layer (billing.schema.ts). Semi-public business data -- India''s GST '
  'portal exposes a public search -- but still confidential-by-default: never returned by any '
  'public endpoint and never written to logs.';

-- ============================================================================
-- updated_at
--
-- Reuses the `set_updated_at()` function Phase 1 created. No new function.
-- ============================================================================

create trigger set_user_billing_profiles_updated_at
  before update on public.user_billing_profiles
  for each row
  execute function public.set_updated_at();

-- ============================================================================
-- Row Level Security
--
-- Table-level grants must be explicit for every Data API role, including service_role -- see Phase
-- 1's migration comment for why (bypassing RLS is not the same as holding a base GRANT).
--
-- **No grant to `anon`.** There is no anonymous-readable billing data, and there never should be.
-- ============================================================================

alter table public.user_billing_profiles enable row level security;

-- ⚠️ REVOKE FIRST. This is not defensive boilerplate -- it is load-bearing.
--
-- This Supabase project carries `ALTER DEFAULT PRIVILEGES ... GRANT ALL ... TO anon, authenticated`
-- for tables in `public`. A freshly created table therefore arrives with **anon already holding
-- SELECT/INSERT/UPDATE/DELETE**, before this migration grants anything. Verified directly against
-- `pg_default_acl` and `information_schema.role_table_grants` while writing this phase: every
-- existing table (`payments` included) shows the same anon grant.
--
-- Simply *not* granting to anon therefore does nothing. Without the revoke below, a comment saying
-- "no anonymous access" would be aspirational rather than true.
--
-- RLS is still the enforcement -- every policy here is `to authenticated`, so an anonymous caller
-- matches none and sees no rows either way. But a table holding tax identifiers should not rely on
-- a single layer, and the grant should say what is actually intended.
revoke all on public.user_billing_profiles from anon;
revoke all on public.user_billing_profiles from authenticated;

grant select, insert, update, delete on public.user_billing_profiles to authenticated;
grant select, insert, update, delete on public.user_billing_profiles to service_role;

-- Read: your own row, and only your own.
--
-- Deliberately **narrower than `profiles`**, which has `profiles_select_own_or_admin`. Decision D6:
-- an admin does not get to read GST data in this phase. A GSTIN and company name are
-- business-identifying tax data with a regulatory dimension, and nothing in this phase requires an
-- admin to see them. Adding an admin policy later is one line; retracting it after admins have come
-- to rely on it is not.
create policy "user_billing_profiles_select_own"
  on public.user_billing_profiles
  for select
  to authenticated
  using (user_id = auth.uid());

-- Insert: only for yourself. `with check` is what stops a caller writing a row under someone
-- else's id even though the request is otherwise well-formed.
create policy "user_billing_profiles_insert_own"
  on public.user_billing_profiles
  for insert
  to authenticated
  with check (user_id = auth.uid());

-- Update: only your own row, and it must still be yours afterwards. Both clauses are required --
-- `using` alone would permit re-pointing a row at another user by changing `user_id`.
create policy "user_billing_profiles_update_own"
  on public.user_billing_profiles
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Delete: only your own row. This is what backs "clear my billing details" -- removing the row is
-- cleaner than leaving one full of NULLs, and it makes "has the user supplied anything?" a single
-- existence check.
create policy "user_billing_profiles_delete_own"
  on public.user_billing_profiles
  for delete
  to authenticated
  using (user_id = auth.uid());

-- ============================================================================
-- Deliberately NOT done here
--
-- - No admin SELECT policy (decision D6, above).
-- - No `anon` grant of any kind.
-- - No change to public.profiles: no column, no policy, no grant, no trigger.
-- - No invoice table, no invoice numbering, no snapshot columns -- a later phase.
-- - No `use_gst_for_invoices` toggle. The 29.17 inspection sketched one, but this phase's approved
--   column list is exactly the five columns above. Absence of a row, or a NULL gst_number, already
--   expresses "do not use GST details", and a boolean can be added additively if the product wants
--   an explicit opt-in.
-- ============================================================================

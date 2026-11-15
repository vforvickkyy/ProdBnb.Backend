-- Phase 29.18-F: Host-visible Booker identity
--
-- One additive function. No table, column, policy, grant or trigger is altered. `public.profiles`
-- RLS is **not touched**: it stays own-row-or-admin exactly as Phase 1 wrote it, and
-- `get_host_public_profile()` and `get_conversations_for_viewer()` are both left alone.
--
-- ============================================================================
-- WHY THIS FUNCTION HAS TO EXIST
--
-- The Phase 29.18-F inspection probed the stack with a real host session inside a rolled-back
-- transaction rather than reasoning from the policy text, and measured this:
--
--   A. host -> own booking row                 1 row   (the host is authorized for the booking)
--   B. host -> the BOOKER's profiles row       0 rows  (the defect)
--   C. host -> own profiles row                1 row   (control: the probe is not vacuous)
--   D. get_host_public_profile(booker)         0 rows  (the existing bridge cannot be reused)
--
-- B is why `booker:profiles!booker_id (...)` inside BOOKING_DETAIL_SELECT comes back null for a
-- host: PostgREST applies RLS to an embedded resource independently of the parent, so the booking
-- survives (the embed is not `!inner`) and the person becomes null. The booking's `booker_id` was
-- never lost -- only the name -- which is why the Host UI has been rendering its honest "Booker"
-- fallback since Phase 29.18-C.
--
-- D is why this is a new function rather than a second caller of the Phase 2 one:
-- `get_host_public_profile()` gates on `exists (... locations where status = 'published')`, and a
-- booker owns no listing. Verified against staging too -- called with a non-host id it returns
-- zero rows.
--
-- This is the same technique, and the same narrow-slice discipline, as Phase 27-3's
-- `get_conversations_for_viewer()`, whose header recorded finding B independently:
-- "A HOST CAN NEVER LEARN THE BOOKER'S NAME."
--
-- ============================================================================
-- WHAT IT DELIBERATELY IS NOT
--
-- Not a general-purpose cross-user data accessor. It answers exactly one question -- "who booked
-- these bookings of mine" -- and exposes only what a Host booking row and its detail screen draw:
--
--   booking_id, id, first_name, last_name, avatar_url
--
-- It never exposes phone, address, profile status, timestamps, booking detail, payment detail, or
-- any other profile column. `email` is not reachable at all: it lives in `auth.users` and has never
-- been on `profiles` (Phase 1). Widening this list is a security decision, not a convenience one.
--
-- Keyed on BOOKING ids, not on a booker id. The question is "who booked *this*", so authorization
-- travels with the subject; a `booker_id`-keyed function would read as "may I see this user", which
-- is a broader question than the product needs.
--
-- No admin branch, matching Phase 27-3. An admin already reads `profiles` directly through
-- `profiles_select_own_or_admin`, so the existing embed already answers for them -- and adding an
-- admin arm here would widen the *host* path for no gain. `GET /v1/admin/bookings` is a thin
-- wrapper over the same service, and because the gate below is `l.host_id = auth.uid()` an admin
-- simply matches nothing here and keeps the embed they already had.
-- ============================================================================

create function public.get_booking_participants(_booking_ids uuid[])
returns table (
  booking_id uuid,
  id uuid,
  first_name text,
  last_name text,
  avatar_url text
)
language sql
security definer
set search_path = public
stable
as $$
  -- Every reference below is table-qualified on purpose. A `returns table` function's OUT
  -- parameters (`id`, `first_name`, ...) shadow same-named columns, and an unqualified reference
  -- would be ambiguous -- the trap Phase 27-7 hit on `get_conversations_for_viewer`.
  select
    b.id,
    p.id,
    p.first_name,
    p.last_name,
    p.avatar_url
  from public.bookings b
  join public.locations l on l.id = b.location_id
  -- LEFT so a booking whose booker has no profile row could never be dropped from the result.
  -- `bookings.booker_id` has a FK to `profiles`, so that cannot happen today; this is belt and
  -- braces, and it also means a booker with null names returns a row of nulls rather than nothing,
  -- which is what lets the caller tell "no name on file" from "not authorized".
  left join public.profiles p on p.id = b.booker_id
  where
    -- Fails closed. Redundant with the host predicate below (comparing to a null auth.uid() yields
    -- null, not true) but stated explicitly so the guarantee does not rest on null-comparison
    -- semantics -- the same line, for the same reason, as Phase 27-3.
    auth.uid() is not null
    and b.id = any(_booking_ids)
    -- THE GATE. The caller must be the host of this booking's location. A caller who hosts nothing
    -- gets nothing, for any input; a host gets exactly the bookings already made on their own
    -- listings, whose `booker_id` they can already read.
    and l.host_id = auth.uid();
$$;

comment on function public.get_booking_participants(uuid[]) is
  'Phase 29.18-F. The booker identity a host may see for bookings on their OWN listings: '
  'booking_id, id, first_name, last_name, avatar_url and nothing else. Gated on '
  'l.host_id = auth.uid(). No admin branch, no anon grant. Never exposes phone, address, status '
  'or any other profile column.';

-- There is no anonymous use case for a booker's identity, so `anon` is revoked rather than relied
-- upon. It fails closed for an unauthenticated caller regardless (auth.uid() is null -> zero rows);
-- this is defence in depth.
--
-- BOTH revokes are required, and this was measured rather than assumed. Revoking from PUBLIC alone
-- is NOT enough on Supabase: this database carries a DEFAULT ACL for functions in `public` that
-- grants EXECUTE to `anon, authenticated, service_role` explicitly, so a newly created function
-- comes into existence with `anon=X/...` already on its ACL -- an explicit grant, which a
-- `revoke ... from public` does not touch. Verified with `has_function_privilege('anon', ...)`,
-- which still returned true after the PUBLIC revoke alone.
--
-- (`get_conversations_for_viewer` ends up without an anon grant despite revoking only from PUBLIC,
-- because Phase 29.6 re-created it with `create or replace`, which preserves the existing ACL
-- instead of re-applying the default. Copying that one line into a brand-new function is therefore
-- a silent hole.)
revoke execute on function public.get_booking_participants(uuid[]) from public;
revoke execute on function public.get_booking_participants(uuid[]) from anon;
grant execute on function public.get_booking_participants(uuid[]) to authenticated, service_role;

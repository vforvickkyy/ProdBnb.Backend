-- Security hardening from Supabase's security advisor (same findings on staging and production).
--
--  1. Five functions had no fixed search_path, so a caller who could create objects earlier in
--     their own search path could, in principle, swap in look-alike tables or functions. Every
--     reference inside them is already schema-qualified; pinning the path just closes the door.
--  2. handle_new_user() is the trigger that creates a profile when someone signs up. Like every
--     function it was also callable on its own through the public API (/rest/v1/rpc). Calling it
--     that way only ever errors, but it shouldn't be reachable at all. Triggers don't need EXECUTE
--     to fire; the grants below keep it explicit for the roles that own signups.
--  3. The pg_net extension (used by the background-jobs dispatcher to call the backend) was
--     installed in the public schema. It now lives in `extensions`, like PostGIS and btree_gist.
--     Its functions stay in the `net` schema, and the dispatcher calls them by that name, so
--     nothing that uses it changes.

-- 1. -------------------------------------------------------------------------------------------
alter function public.set_updated_at() set search_path = public, extensions;
alter function public.enforce_refund_balance() set search_path = public, extensions;
alter function public.touch_conversation_on_message() set search_path = public, extensions;
alter function public.is_interval_available(uuid, timestamptz, timestamptz) set search_path = public, extensions;
alter function public.search_locations(
  text, text, text, text, uuid[], uuid[], uuid[], integer, integer,
  double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  text, integer, integer,
  integer, integer
) set search_path = public, extensions;

-- 2. -------------------------------------------------------------------------------------------
revoke all on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.handle_new_user() to supabase_auth_admin, service_role;

-- 3. -------------------------------------------------------------------------------------------
drop extension if exists pg_net;
create extension pg_net with schema extensions;

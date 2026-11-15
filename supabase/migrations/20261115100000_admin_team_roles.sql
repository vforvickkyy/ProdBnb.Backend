-- Admin Console 3: admin team roles (Super admin / Moderator / Support / Finance).
--
-- ============================================================================
-- MODEL
--
-- `user_roles.role = 'admin'` stays exactly what it has been since Phase 1: the platform-level
-- "is an administrator" fact that every RLS policy's `has_role(auth.uid(), 'admin')` arm reads.
-- Nothing about RLS changes here.
--
-- `admin_team_members` refines it: WHICH administrator powers an admin holds, enforced by the
-- backend's /v1/admin/* layer (src/modules/admin/permissions.ts). Exactly one row per admin.
--
--   user_roles 'admin' present  <=>  admin_team_members row present
--
-- That invariant is maintained by triggers on user_roles, so the documented SQL bootstrap
-- (docs/DATABASE.md "Granting the admin role": insert a user_roles 'admin' row with the
-- service-role key) keeps working unchanged and yields a super_admin -- the only sensible reading
-- of "someone with direct database access made this person an admin".
--
-- KNOWN BOUNDARY (documented, deliberate): team roles restrict what the Admin API lets each admin
-- DO. Every write path is service-role behind that API, so writes are fully gated. READS through
-- raw PostgREST still follow the pre-existing `has_role(admin)` RLS arms, i.e. any admin can read
-- what any admin could read before this migration. Pushing team roles into every RLS policy is a
-- separate, larger change.
--
-- ============================================================================
-- PRIVILEGE ESCALATION CLOSED
--
-- Phase 1's `user_roles_insert_self_or_admin` / `user_roles_delete_own_or_admin` let ANY admin
-- insert or delete ANY role for ANY user through raw PostgREST -- including `admin` itself. With
-- team roles, that would let a Support admin mint a brand-new admin (who the trigger below would
-- make a super_admin). Both policies lose their admin arm: an admin now changes other people's
-- roles only through the audited API (service-role). Self-service booker/host is untouched.
-- Verified unused: no backend code path inserts/deletes user_roles with an admin's scoped client.
-- ============================================================================

create table public.admin_team_members (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  team_role text not null check (team_role in ('super_admin', 'moderator', 'support', 'finance')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.admin_team_members is
  'Which administrator powers each admin holds. One row per user holding user_roles.role = admin '
  '(kept in sync by triggers on user_roles). Enforced by the backend /v1/admin API, not by RLS.';

create index admin_team_members_team_role_idx on public.admin_team_members (team_role);

create trigger set_admin_team_members_updated_at
  before update on public.admin_team_members
  for each row execute function public.set_updated_at();

alter table public.admin_team_members enable row level security;

revoke all on public.admin_team_members from anon, authenticated;
grant select on public.admin_team_members to authenticated;
grant select, insert, update, delete on public.admin_team_members to service_role;

-- Every admin sees the whole team -- the same "accountability across the whole admin team"
-- reasoning admin_audit_log_select_admin_only uses.
create policy "admin_team_members_select_admin_only"
  on public.admin_team_members
  for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

-- -- Invariant: user_roles 'admin' <=> admin_team_members row ---------------------------------

create function public.sync_admin_team_on_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.role = 'admin' then
    -- `do nothing`, not `do update`: admin_set_team_member() writes the chosen team role FIRST and
    -- then inserts the user_roles row, so a role chosen through the API is never overwritten here.
    insert into public.admin_team_members (user_id, team_role)
    values (new.user_id, 'super_admin')
    on conflict (user_id) do nothing;
    return new;
  end if;

  if tg_op = 'DELETE' and old.role = 'admin' then
    delete from public.admin_team_members where user_id = old.user_id;
    return old;
  end if;

  return coalesce(new, old);
end;
$$;

revoke all on function public.sync_admin_team_on_role_change() from public, anon, authenticated;

create trigger on_user_role_admin_change
  after insert or delete on public.user_roles
  for each row execute function public.sync_admin_team_on_role_change();

-- Existing admins become super admins: they already hold every power the API has.
insert into public.admin_team_members (user_id, team_role)
select user_id, 'super_admin' from public.user_roles where role = 'admin'
on conflict (user_id) do nothing;

-- -- Atomic team management (service_role only) ----------------------------------------------
--
-- The backend has no multi-statement transaction facility, so "set the team role AND hold the
-- admin role" and the last-super-admin guard live here, under one advisory lock, rather than as
-- separate PostgREST calls that could interleave.

create function public.admin_set_team_member(_user_id uuid, _team_role text, _actor_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  _previous text;
begin
  if _team_role not in ('super_admin', 'moderator', 'support', 'finance') then
    raise exception 'invalid_team_role' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('public.admin_team_members'));

  select team_role into _previous from public.admin_team_members where user_id = _user_id;

  if _previous = 'super_admin' and _team_role <> 'super_admin'
     and (select count(*) from public.admin_team_members where team_role = 'super_admin') <= 1 then
    raise exception 'last_super_admin' using errcode = 'P0001';
  end if;

  insert into public.admin_team_members (user_id, team_role, created_by)
  values (_user_id, _team_role, _actor_id)
  on conflict (user_id) do update set team_role = excluded.team_role;

  insert into public.user_roles (user_id, role)
  values (_user_id, 'admin')
  on conflict (user_id, role) do nothing;

  return _previous;
end;
$$;

create function public.admin_remove_team_member(_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  _previous text;
begin
  perform pg_advisory_xact_lock(hashtext('public.admin_team_members'));

  select team_role into _previous from public.admin_team_members where user_id = _user_id;
  if _previous is null then
    raise exception 'not_a_team_member' using errcode = 'P0002';
  end if;

  if _previous = 'super_admin'
     and (select count(*) from public.admin_team_members where team_role = 'super_admin') <= 1 then
    raise exception 'last_super_admin' using errcode = 'P0001';
  end if;

  -- The trigger removes the admin_team_members row; deleted explicitly as well so the function's
  -- outcome never depends on trigger presence.
  delete from public.user_roles where user_id = _user_id and role = 'admin';
  delete from public.admin_team_members where user_id = _user_id;

  return _previous;
end;
$$;

-- Lookup for "add a team member by email". `profiles` has no email column by design (Phase 1);
-- auth.users is reachable only from a definer function, and only the backend may call it.
create function public.admin_find_user_id_by_email(_email text)
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select u.id from auth.users u where lower(u.email) = lower(btrim(_email)) limit 1;
$$;

revoke all on function public.admin_set_team_member(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.admin_remove_team_member(uuid) from public, anon, authenticated;
revoke all on function public.admin_find_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.admin_set_team_member(uuid, text, uuid) to service_role;
grant execute on function public.admin_remove_team_member(uuid) to service_role;
grant execute on function public.admin_find_user_id_by_email(text) to service_role;

-- -- Close the admin arm on user_roles writes -------------------------------------------------

drop policy "user_roles_insert_self_or_admin" on public.user_roles;
drop policy "user_roles_delete_own_or_admin" on public.user_roles;

create policy "user_roles_insert_self"
  on public.user_roles
  for insert
  to authenticated
  with check (user_id = auth.uid() and role in ('booker', 'host'));

create policy "user_roles_delete_own"
  on public.user_roles
  for delete
  to authenticated
  using (user_id = auth.uid() and role in ('booker', 'host'));

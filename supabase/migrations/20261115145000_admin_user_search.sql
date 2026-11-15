-- Admin Console 2: find people by name OR email (the host picker behind "New listing", and the
-- recipient picker behind direct notifications). Email lives in auth.users, which no API role can
-- read directly, hence a service-role-only SECURITY DEFINER function.
--
-- LIKE wildcards in the search term are escaped, so "50%" matches the literal text.

create function public.admin_search_users(_term text, _limit integer default 20)
returns table (id uuid, first_name text, last_name text, email text, status text)
language sql
security definer
set search_path = ''
stable
as $$
  with term as (
    select '%' || replace(replace(replace(btrim(coalesce(_term, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern
  )
  select p.id, p.first_name, p.last_name, u.email::text, p.status
  from public.profiles p
  join auth.users u on u.id = p.id
  cross join term t
  where p.status <> 'deleted'
    and (
      u.email ilike t.pattern
      or p.first_name ilike t.pattern
      or p.last_name ilike t.pattern
      or (coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')) ilike t.pattern
    )
  order by (u.email ilike btrim(_term)) desc, p.first_name nulls last, p.last_name nulls last
  limit greatest(1, least(coalesce(_limit, 20), 50));
$$;

revoke all on function public.admin_search_users(text, integer) from public, anon, authenticated;
grant execute on function public.admin_search_users(text, integer) to service_role;

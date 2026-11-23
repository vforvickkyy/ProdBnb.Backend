-- ============================================================================
-- Fix: listing IDs past the padding width
--
-- next_listing_code() padded the number with lpad(), and PostgreSQL's lpad() TRUNCATES text that
-- is already longer than the width: lpad('100', 2, '0') = '10'. With the default 2 digits, the
-- 100th listing therefore got 'HKLS10' -- taken -- and so did every later number (101 -> '10', ...),
-- so the loop never ended and creating a listing hung.
--
-- Now the number is only padded when it is shorter than the width (HKLS07, HKLS99, HKLS100), the
-- same rule the backend and admin preview already use (String.padStart never truncates). A bounded
-- loop also turns any future surprise into an error instead of a hang.
-- ============================================================================

create or replace function public.next_listing_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  _prefix text;
  _digits integer;
  _n integer;
  _num text;
  _code text;
  _attempt integer := 0;
begin
  loop
    _attempt := _attempt + 1;
    if _attempt > 10000 then
      raise exception 'next_listing_code: no free listing ID after % tries', _attempt - 1;
    end if;

    update public.platform_settings
       set listing_id_next = listing_id_next + 1
     where singleton
    returning listing_id_prefix, listing_id_digits, listing_id_next - 1
      into _prefix, _digits, _n;

    if not found then
      -- No settings row (never in practice): fall back to the defaults rather than fail a listing.
      _prefix := 'HKLS';
      _digits := 2;
      _n := (select count(*) from public.locations)::integer + _attempt;
    end if;

    _num := _n::text;
    if length(_num) < _digits then
      _num := lpad(_num, _digits, '0');
    end if;
    _code := _prefix || _num;
    exit when not exists (select 1 from public.locations where upper(listing_code) = upper(_code));
  end loop;
  return _code;
end;
$$;

revoke all on function public.next_listing_code() from public, anon, authenticated;
grant execute on function public.next_listing_code() to service_role;

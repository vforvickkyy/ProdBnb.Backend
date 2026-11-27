-- ============================================================================
-- Listing privacy: one fixed, secret offset per listing.
--
-- Until now the approximate point was the real pin moved 0.6-1.4 km in a fresh random direction
-- every time the pin moved. Someone watching a listing across several pin edits could average the
-- points and narrow down the real spot. Now each listing gets its offset once (stored here, never
-- sent to anyone) and the approximate point is always "real pin + that same offset". Existing
-- listings keep exactly the point they show today: their stored offset is read back from it.
-- ============================================================================

alter table public.locations
  add column privacy_offset_north_m double precision,
  add column privacy_offset_east_m double precision;

comment on column public.locations.privacy_offset_north_m is
  'Secret, fixed offset (metres north) from the real pin to the public approximate point. Never exposed.';
comment on column public.locations.privacy_offset_east_m is
  'Secret, fixed offset (metres east) from the real pin to the public approximate point. Never exposed.';

-- Nobody but the backend reads these.
revoke select (privacy_offset_north_m, privacy_offset_east_m) on public.locations from anon, authenticated;
revoke update (privacy_offset_north_m, privacy_offset_east_m) on public.locations from anon, authenticated;
revoke insert (privacy_offset_north_m, privacy_offset_east_m) on public.locations from anon, authenticated;

create or replace function public.set_location_public_point()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  _bearing double precision;
  _metres double precision;
  _lng double precision;
begin
  -- The offset is chosen once and kept for the life of the listing, whatever happens to the pin.
  if tg_op = 'UPDATE' then
    new.privacy_offset_north_m := old.privacy_offset_north_m;
    new.privacy_offset_east_m := old.privacy_offset_east_m;
  end if;
  if new.privacy_offset_north_m is null or new.privacy_offset_east_m is null then
    _bearing := random() * 2 * pi();
    _metres := 600 + random() * 800;
    new.privacy_offset_north_m := _metres * cos(_bearing);
    new.privacy_offset_east_m := _metres * sin(_bearing);
  end if;

  if new.latitude is null or new.longitude is null then
    new.public_latitude := null;
    new.public_longitude := null;
  elsif new.show_exact_location then
    new.public_latitude := new.latitude;
    new.public_longitude := new.longitude;
  else
    _lng := new.longitude + new.privacy_offset_east_m / (111320.0 * greatest(cos(radians(new.latitude)), 0.01));
    if _lng > 180 then _lng := _lng - 360; elsif _lng < -180 then _lng := _lng + 360; end if;
    new.public_latitude := round(greatest(least(new.latitude + new.privacy_offset_north_m / 111320.0, 89.9), -89.9)::numeric, 5);
    new.public_longitude := round(_lng::numeric, 5);
  end if;
  return new;
end;
$$;

revoke all on function public.set_location_public_point() from public, anon, authenticated;

drop trigger locations_set_public_point on public.locations;
create trigger locations_set_public_point
  before insert or update of latitude, longitude, show_exact_location, public_latitude, public_longitude,
    privacy_offset_north_m, privacy_offset_east_m
  on public.locations
  for each row execute function public.set_location_public_point();

-- Backfill: read today's offset back from today's approximate point, so nothing moves on the map.
alter table public.locations disable trigger set_locations_updated_at;
alter table public.locations disable trigger locations_set_public_point;
update public.locations
set privacy_offset_north_m = (public_latitude - latitude) * 111320.0,
    privacy_offset_east_m = (public_longitude - longitude) * 111320.0 * greatest(cos(radians(latitude)), 0.01)
where latitude is not null and longitude is not null
  and public_latitude is not null and public_longitude is not null
  and not show_exact_location;
alter table public.locations enable trigger locations_set_public_point;
-- Everyone else (exact listings, no pin yet) gets a fresh offset, used if they ever go approximate.
update public.locations set privacy_offset_north_m = null where privacy_offset_north_m is null;
alter table public.locations enable trigger set_locations_updated_at;

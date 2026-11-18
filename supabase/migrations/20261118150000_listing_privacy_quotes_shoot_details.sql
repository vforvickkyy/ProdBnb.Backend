-- Booking refinements: listing address privacy, "request pricing" listings, and shoot details.
--
--  * Address privacy. Before a booking, people see the listing's town and a new "area" (e.g.
--    "Bandra West") -- never the street, postcode or exact pin. Maps show a ~2 km circle around an
--    APPROXIMATE point (public_latitude/public_longitude), offset 0.6-1.4 km in a random direction
--    from the real spot, so the real spot is always inside the circle but can't be worked out from
--    it. The offset is picked once and kept until the host moves the pin, so reloading the page (or
--    averaging many reads) never narrows it down.
--    Only the team can mark a listing "show exact location" (famous places, e.g. a film city); its
--    public point is then the real one. Hosts cannot change that flag.
--    Enforced in the database, not just the API: anon/authenticated lose SELECT on address_line1,
--    address_line2, postal_code, latitude, longitude and location_point, so the public API key can't
--    read them through PostgREST either. The backend reads them with the service role after its own
--    owner/admin checks. NOTE: a column added to `locations` later is not readable by anon/
--    authenticated until it is granted below the same way.
--  * Request pricing. A listing can hide its prices (`price_on_request`). Booking it sends a request
--    without a price (pricing_status 'awaiting_quote'); the host replies with a price ('quoted',
--    status confirmed) and the booker then pays. A request waiting for a price does not hold the
--    slot -- otherwise anyone could block a date for free -- only a quoted booking does. Its pricing
--    rows are hidden from everyone but the host and admins.
--  * Shoot details on bookings: shoot type (from the use-case list, or the booker's own words), how
--    many people will be on set, optional project and production names, notes, and when the booker
--    accepted the terms. The host sees all of it before deciding.

-- 1. Listings: new columns ------------------------------------------------------------------------

alter table public.locations
  add column area text check (area is null or char_length(area) between 1 and 80),
  add column show_exact_location boolean not null default false,
  add column price_on_request boolean not null default false,
  add column public_latitude double precision,
  add column public_longitude double precision;

alter table public.locations
  add column public_point extensions.geography(Point, 4326) generated always as (
    case
      when public_latitude is not null and public_longitude is not null
        then extensions.ST_SetSRID(extensions.ST_MakePoint(public_longitude, public_latitude), 4326)::extensions.geography
    end
  ) stored;

create index locations_public_point_idx on public.locations using gist (public_point);
create index locations_public_lat_lng_idx on public.locations (public_latitude, public_longitude);

comment on column public.locations.area is
  'The neighbourhood or area shown to everyone before booking (with city/region), e.g. "Bandra West".';
comment on column public.locations.show_exact_location is
  'Set by the team only: show the full address and exact pin before booking (famous places).';
comment on column public.locations.price_on_request is
  'Hide prices; bookings are requests the host answers with a price (bookings.pricing_status).';
comment on column public.locations.public_latitude is
  'Approximate point shown before booking (exact when show_exact_location). Set by trigger only.';

-- The search vector also covers the area, so "Bandra" finds listings in Bandra. search_locations()
-- reads the column, so it is dropped first and recreated below.
drop function public.search_locations(
  text, text, text, text, uuid[], uuid[], uuid[], integer, integer,
  double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  text, integer, integer,
  integer, integer
);

alter table public.locations drop column search_vector;
alter table public.locations
  add column search_vector tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A')
    || setweight(to_tsvector('english'::regconfig, coalesce(city, '')), 'B')
    || setweight(to_tsvector('english'::regconfig, coalesce(area, '')), 'B')
    || setweight(to_tsvector('english'::regconfig, coalesce(description, '')), 'C')
  ) stored;
create index locations_search_vector_idx on public.locations using gin (search_vector);

-- 2. The approximate point ------------------------------------------------------------------------

create function public.set_location_public_point()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  _bearing double precision;
  _metres double precision;
  _lng double precision;
begin
  if new.latitude is null or new.longitude is null then
    new.public_latitude := null;
    new.public_longitude := null;
  elsif new.show_exact_location then
    new.public_latitude := new.latitude;
    new.public_longitude := new.longitude;
  elsif tg_op = 'UPDATE'
        and not old.show_exact_location
        and old.public_latitude is not null
        and old.public_longitude is not null
        and new.latitude = old.latitude
        and new.longitude = old.longitude then
    -- Same pin: keep the same offset.
    new.public_latitude := old.public_latitude;
    new.public_longitude := old.public_longitude;
  else
    _bearing := random() * 2 * pi();
    _metres := 600 + random() * 800;
    _lng := new.longitude + (_metres * sin(_bearing)) / (111320.0 * greatest(cos(radians(new.latitude)), 0.01));
    if _lng > 180 then _lng := _lng - 360; elsif _lng < -180 then _lng := _lng + 360; end if;
    new.public_latitude := round(greatest(least(new.latitude + (_metres * cos(_bearing)) / 111320.0, 89.9), -89.9)::numeric, 5);
    new.public_longitude := round(_lng::numeric, 5);
  end if;
  return new;
end;
$$;

revoke all on function public.set_location_public_point() from public, anon, authenticated;

create trigger locations_set_public_point
  before insert or update of latitude, longitude, show_exact_location, public_latitude, public_longitude
  on public.locations
  for each row execute function public.set_location_public_point();

-- Backfill every existing listing (without touching updated_at).
alter table public.locations disable trigger set_locations_updated_at;
update public.locations set public_latitude = null where latitude is not null and longitude is not null;
alter table public.locations enable trigger set_locations_updated_at;

-- 3. Who can read what ----------------------------------------------------------------------------

revoke select on public.locations from anon, authenticated;
grant select (
  id, host_id, title, description, city, region, country, area,
  public_latitude, public_longitude, public_point,
  capacity, timezone, instant_booking_enabled, show_exact_location, price_on_request,
  status, moderation_reason, suspended_by_host_suspension,
  base_price_minor_units, currency, search_vector, created_at, updated_at
) on public.locations to anon, authenticated;

-- Hosts set their own area and price-on-request; show_exact_location is the team's (service role).
grant insert (area, price_on_request) on public.locations to authenticated;
grant update (area, price_on_request) on public.locations to authenticated;

-- Hidden prices stay hidden: a price-on-request listing's pricing rows are visible to its host and
-- admins only.
drop policy location_pricing_select_via_location on public.location_pricing;
create policy location_pricing_select_via_location on public.location_pricing
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.locations l
      where l.id = location_pricing.location_id
        and (
          (l.status = 'published' and not l.price_on_request)
          or l.host_id = auth.uid()
          or public.has_role(auth.uid(), 'admin')
        )
    )
  );

-- 4. Search: approximate points only --------------------------------------------------------------

create function public.search_locations(
  _search text default null,
  _city text default null,
  _region text default null,
  _country text default null,
  _category_ids uuid[] default null,
  _amenity_ids uuid[] default null,
  _use_case_ids uuid[] default null,
  _capacity_min integer default null,
  _capacity_max integer default null,
  _lat double precision default null,
  _lng double precision default null,
  _radius_km double precision default null,
  _north double precision default null,
  _south double precision default null,
  _east double precision default null,
  _west double precision default null,
  _sort text default 'newest',
  _page integer default 1,
  _page_size integer default 20,
  _price_min integer default null,
  _price_max integer default null
)
returns table (
  id uuid,
  title text,
  excerpt text,
  city text,
  region text,
  country text,
  area text,
  latitude double precision,
  longitude double precision,
  exact_location boolean,
  capacity integer,
  distance_km double precision,
  categories jsonb,
  use_cases jsonb,
  primary_media_key text,
  starting_price jsonb,
  price_on_request boolean,
  created_at timestamptz,
  total_count bigint
)
language sql
security invoker
stable
as $$
  -- Only columns anon can read: latitude/longitude here are the approximate public point (the
  -- real one when the team marked the listing "show exact location"). Distances and the radius
  -- filter use the same point, so they can't be used to find the real spot either.
  with filtered as (
    select
      l.id, l.title, l.description, l.city, l.region, l.country, l.area,
      l.public_latitude, l.public_longitude, l.public_point, l.show_exact_location,
      l.capacity, l.price_on_request, l.search_vector, l.created_at
    from public.locations l
    where l.status = 'published'
      and (_search is null or l.search_vector @@ websearch_to_tsquery('english', _search))
      and (_city is null or lower(l.city) = lower(_city))
      and (_region is null or lower(l.region) = lower(_region))
      and (_country is null or lower(l.country) = lower(_country))
      and (_capacity_min is null or l.capacity >= _capacity_min)
      and (_capacity_max is null or l.capacity <= _capacity_max)
      and (
        _category_ids is null or exists (
          select 1 from public.location_categories lc
          where lc.location_id = l.id and lc.category_id = any(_category_ids)
        )
      )
      and (
        _use_case_ids is null or exists (
          select 1 from public.location_use_cases luc
          where luc.location_id = l.id and luc.use_case_id = any(_use_case_ids)
        )
      )
      and (
        _amenity_ids is null or (
          select count(distinct la.amenity_id)
          from public.location_amenities la
          where la.location_id = l.id and la.amenity_id = any(_amenity_ids)
        ) = cardinality(_amenity_ids)
      )
      and (
        _radius_km is null or (
          l.public_point is not null
          and extensions.ST_DWithin(
            l.public_point,
            extensions.ST_SetSRID(extensions.ST_MakePoint(_lng, _lat), 4326)::extensions.geography,
            _radius_km * 1000
          )
        )
      )
      and (
        _north is null or (
          l.public_latitude between _south and _north and l.public_longitude between _west and _east
        )
      )
      -- Budget: the lowest active INR price must fall inside the range. A price-on-request listing
      -- has no public price, so it never matches a budget.
      and (
        (_price_min is null and _price_max is null) or (
          not l.price_on_request
          and exists (
            select 1
            from (
              select min(p.amount_minor_units) as lowest
              from public.location_pricing p
              where p.location_id = l.id
                and p.is_active
                and p.amount_minor_units > 0
                and p.currency = 'INR'
            ) m
            where m.lowest is not null
              and (_price_min is null or m.lowest >= _price_min)
              and (_price_max is null or m.lowest <= _price_max)
          )
        )
      )
  )
  select
    f.id,
    f.title,
    left(f.description, 240) as excerpt,
    f.city,
    f.region,
    f.country,
    f.area,
    f.public_latitude as latitude,
    f.public_longitude as longitude,
    f.show_exact_location as exact_location,
    f.capacity,
    case
      when _lat is not null then
        extensions.ST_Distance(
          f.public_point,
          extensions.ST_SetSRID(extensions.ST_MakePoint(_lng, _lat), 4326)::extensions.geography
        ) / 1000
    end as distance_km,
    (
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name)), '[]'::jsonb)
      from public.location_categories lc
      join public.categories c on c.id = lc.category_id
      where lc.location_id = f.id
    ) as categories,
    (
      select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name)), '[]'::jsonb)
      from public.location_use_cases luc
      join public.use_cases u on u.id = luc.use_case_id
      where luc.location_id = f.id
    ) as use_cases,
    (
      select lm.storage_key
      from public.location_media lm
      where lm.location_id = f.id
        and lm.section_id is null
      order by lm.position asc
      limit 1
    ) as primary_media_key,
    -- Every column is qualified: the RETURNS TABLE names are in scope in this body.
    case when not f.price_on_request then (
      select jsonb_build_object(
               'amount_minor_units', t.amount_minor_units,
               'currency',           t.currency,
               'booking_type',       t.booking_type
             )
      from (
        select
          p.amount_minor_units,
          p.currency,
          p.booking_type,
          (min(p.currency) over () = max(p.currency) over ()) as single_currency
        from public.location_pricing p
        where p.location_id = f.id
          and p.is_active
          and p.amount_minor_units > 0
      ) t
      order by
        case when t.single_currency then t.amount_minor_units end asc nulls last,
        case t.booking_type
          when 'hourly'    then 1
          when 'half_day'  then 2
          when 'day'       then 3
          when 'multi_day' then 4
        end asc
      limit 1
    ) end as starting_price,
    f.price_on_request,
    f.created_at,
    count(*) over () as total_count
  from filtered f
  order by
    (case when _sort = 'nearest' and _lat is not null then
      extensions.ST_Distance(
        f.public_point,
        extensions.ST_SetSRID(extensions.ST_MakePoint(_lng, _lat), 4326)::extensions.geography
      )
    end) asc,
    (case when _sort = 'relevant' and _search is not null then
      ts_rank(f.search_vector, websearch_to_tsquery('english', _search))
    end) desc,
    f.created_at desc
  offset (_page - 1) * least(_page_size, 100)
  limit least(_page_size, 100);
$$;

grant execute on function public.search_locations(
  text, text, text, text, uuid[], uuid[], uuid[], integer, integer,
  double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  text, integer, integer,
  integer, integer
) to anon, authenticated;

-- 5. Shoot types --------------------------------------------------------------------------------

insert into public.use_cases (name) values ('Reels'), ('Podcast') on conflict (name) do nothing;

-- 6. Bookings: shoot details and quotes -----------------------------------------------------------

alter table public.bookings
  add column shoot_type_id uuid references public.use_cases (id) on delete set null,
  add column shoot_type text check (shoot_type is null or char_length(shoot_type) between 1 and 80),
  add column crew_size integer check (crew_size is null or crew_size between 1 and 10000),
  add column project_name text check (project_name is null or char_length(project_name) between 1 and 120),
  add column production_name text check (production_name is null or char_length(production_name) between 1 and 120),
  add column shoot_notes text check (shoot_notes is null or char_length(shoot_notes) between 1 and 1000),
  add column terms_accepted_at timestamptz,
  add column pricing_status text not null default 'priced'
    check (pricing_status in ('priced', 'awaiting_quote', 'quoted')),
  add column quoted_at timestamptz;

create index bookings_shoot_type_id_idx on public.bookings (shoot_type_id) where shoot_type_id is not null;
create index bookings_awaiting_quote_idx on public.bookings (location_id) where pricing_status = 'awaiting_quote';

comment on column public.bookings.shoot_type is
  'What the shoot is, as the booker chose it (a use-case name, or their own words for "Other").';
comment on column public.bookings.pricing_status is
  'priced: normal booking. awaiting_quote: a request on a price-on-request listing, no price yet, '
  'does not hold the slot. quoted: the host sent a price (status confirmed), the booker pays next.';

grant select (
  shoot_type_id, shoot_type, crew_size, project_name, production_name, shoot_notes,
  terms_accepted_at, pricing_status, quoted_at
) on public.bookings to authenticated;

-- A request still waiting for a price doesn't hold the slot.
alter table public.bookings drop constraint bookings_location_id_tstzrange_excl;
alter table public.bookings
  add constraint bookings_location_id_tstzrange_excl exclude using gist (
    location_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status in ('requested', 'confirmed') and pricing_status <> 'awaiting_quote');

create or replace function public.has_conflicting_period(_location_id uuid, _start_at timestamptz, _end_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1 from public.location_blocked_periods b
      where b.location_id = _location_id
        and tstzrange(b.start_at, b.end_at, '[)') && tstzrange(_start_at, _end_at, '[)')
    )
    or exists (
      select 1 from public.bookings bk
      where bk.location_id = _location_id
        and bk.status in ('requested', 'confirmed')
        and bk.pricing_status <> 'awaiting_quote'
        and tstzrange(bk.start_at, bk.end_at, '[)') && tstzrange(_start_at, _end_at, '[)')
    );
$$;

-- 7. Expiry --------------------------------------------------------------------------------------
--  * A request still waiting for a price is closed once its start time passes (always, even with
--    the unpaid-hold timer off).
--  * A quoted booking gets at least 24 hours from the quote to be paid (the booker may not be
--    looking when the host replies), or the unpaid-hold time if that is longer.
--  * Everything else is unchanged.

create or replace function public.expire_unpaid_bookings(_location_id uuid default null)
returns setof uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  _minutes integer;
begin
  select unpaid_hold_minutes into _minutes from public.platform_settings where singleton;

  return query
  with expired as (
    update public.bookings b
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = null,
        cancellation_reason = case
          when b.pricing_status = 'awaiting_quote' then 'The host did not send a price before the booking time.'
          else 'Payment was not completed in time.'
        end,
        hold_expired_at = now()
    where b.status in ('requested', 'confirmed')
      and (_location_id is null or b.location_id = _location_id)
      and (
        (b.pricing_status = 'awaiting_quote' and b.start_at <= now())
        or (
          b.pricing_status <> 'awaiting_quote'
          and _minutes is not null
          and (
            (b.pricing_status = 'quoted'
              and coalesce(b.quoted_at, b.created_at) < now() - make_interval(mins => greatest(_minutes, 1440)))
            or (b.pricing_status = 'priced'
              and b.created_at < now() - make_interval(mins => _minutes))
          )
          and not exists (
            select 1 from public.payments p
            where p.booking_id = b.id and p.status in ('success', 'partially_refunded', 'refunded')
          )
          and not exists (
            select 1 from public.payments p
            where p.booking_id = b.id
              and p.status in ('created', 'pending')
              and coalesce(p.expires_at, p.created_at + interval '60 minutes') > now()
          )
        )
      )
    returning b.id, b.booker_id, b.pricing_status
  ),
  notified as (
    insert into public.notifications (user_id, type, title, body, entity_type, entity_id, data, source_event_id)
    select e.booker_id,
           'booking_cancelled',
           case when e.pricing_status = 'awaiting_quote' then 'Booking request closed' else 'Booking cancelled' end,
           case
             when e.pricing_status = 'awaiting_quote'
               then 'The host didn''t send a price before your booking time, so the request was closed.'
             else 'Your booking was cancelled because payment was not completed in time.'
           end,
           'booking',
           e.id,
           jsonb_build_object('reason', case when e.pricing_status = 'awaiting_quote' then 'quote_not_sent' else 'unpaid_hold_expired' end),
           'booking:' || e.id || ':booking_cancelled'
    from expired e
    on conflict (user_id, source_event_id) do nothing
    returning 1
  )
  select e.id from expired e;
end;
$$;

revoke all on function public.expire_unpaid_bookings(uuid) from public, anon, authenticated;
grant execute on function public.expire_unpaid_bookings(uuid) to service_role;

-- 8. Calendar availability: same rule as has_conflicting_period ------------------------------------

CREATE OR REPLACE FUNCTION public.get_location_availability(_location_id uuid, _from_date date, _to_date date)
 RETURNS TABLE(date date, start_at timestamp with time zone, end_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  _tz text;
  _cur_date date;
  _day_name text;
  _override record;
  _windows tstzrange[];
  _available tstzmultirange;
  _range tstzrange;
  _rule record;
  _day_names constant text[] := array[
    'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'
  ];
begin
  if _to_date < _from_date then
    raise exception 'to_date must not be before from_date';
  end if;
  if (_to_date - _from_date) > 90 then
    raise exception 'date range must not exceed 90 days';
  end if;

  select l.timezone into _tz
  from public.locations l
  where l.id = _location_id
    and (l.status = 'published' or l.host_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

  if _tz is null then
    return;
  end if;

  _cur_date := _from_date;
  while _cur_date <= _to_date loop
    _windows := array[]::tstzrange[];

    select o.status, o.start_time, o.end_time into _override
    from public.location_availability_overrides o
    where o.location_id = _location_id and o.date = _cur_date;

    if found then
      if _override.status = 'available' then
        _windows := array[
          tstzrange(
            (_cur_date + _override.start_time) at time zone _tz,
            (_cur_date + _override.end_time) at time zone _tz,
            '[)'
          )
        ];
      end if;
    else
      _day_name := _day_names[extract(dow from _cur_date)::int + 1];
      for _rule in
        select r.start_time, r.end_time
        from public.location_availability_rules r
        where r.location_id = _location_id and r.day_of_week = _day_name
        order by r.start_time
      loop
        _windows := _windows || tstzrange(
          (_cur_date + _rule.start_time) at time zone _tz,
          (_cur_date + _rule.end_time) at time zone _tz,
          '[)'
        );
      end loop;
    end if;

    _available := '{}'::tstzmultirange;
    for _range in select unnest(_windows) loop
      _available := _available + tstzmultirange(_range);
    end loop;

    for _range in
      select tstzrange(b.start_at, b.end_at, '[)')
      from public.location_blocked_periods b
      where b.location_id = _location_id
        and tstzrange(b.start_at, b.end_at, '[)')
          && tstzrange(
            (_cur_date::timestamp) at time zone _tz,
            ((_cur_date + 1)::timestamp) at time zone _tz,
            '[)'
          )
    loop
      _available := _available - tstzmultirange(_range);
    end loop;

    -- Phase 6: also subtract active (requested/confirmed) bookings -- except requests still
    -- waiting for a price, which do not hold the slot -- the
    -- same overlap-filter shape as the blocks loop directly above.
    for _range in
      select tstzrange(bk.start_at, bk.end_at, '[)')
      from public.bookings bk
      where bk.location_id = _location_id
        and bk.status in ('requested', 'confirmed')
        and bk.pricing_status <> 'awaiting_quote'
        and tstzrange(bk.start_at, bk.end_at, '[)')
          && tstzrange(
            (_cur_date::timestamp) at time zone _tz,
            ((_cur_date + 1)::timestamp) at time zone _tz,
            '[)'
          )
    loop
      _available := _available - tstzmultirange(_range);
    end loop;

    for _range in select unnest(_available) loop
      date := _cur_date;
      start_at := lower(_range);
      end_at := upper(_range);
      return next;
    end loop;

    _cur_date := _cur_date + 1;
  end loop;
end;
$function$

;

-- Listing IDs, listing details, rules, props and a stronger search.
--
--  1. Listing IDs. Every listing gets a short code like HKLS01. The prefix, the number of digits and the
--     next number live in platform_settings, so the team controls them in the admin console. A code is
--     assigned automatically to every new listing (a trigger), existing listings are numbered in the
--     order they were created, and the team can change a single listing's code. Changing the prefix
--     later only affects listings created afterwards.
--     The code is internal: only the host and the team see it. It is NOT granted to anon/authenticated
--     (the backend reads it with the service role and hides it from everyone else) and it is not part
--     of the public search vector.
--  2. Details a production crew asks about: area, number of sets, parking spaces, restrooms, whether
--     electricity is included, and whether any permission is needed. Max crew size is the existing
--     `capacity` column.
--  3. Amenities and rules as tick boxes: the amenities catalogue gains a kind ('amenity' or 'rule'), a
--     group and an order, and many new items (vanity room, changing room, ...). Hosts and the team can
--     also add their own free-text points (custom_amenities, custom_rules).
--  4. Props: a list on the listing of things that come with it (included) and things the host can
--     provide for an extra price (add-on). Stored as JSON on the listing; the API validates every item.
--  5. Search: filters for the new details, quick facts on result cards, and sorting by price.
--     Also a small function listing the cities (and shoot types per city) that have published listings,
--     for the website's city pages.

-- 1. Listing IDs ---------------------------------------------------------------------------------

alter table public.platform_settings
  add column listing_id_prefix text not null default 'HKLS'
    check (listing_id_prefix ~ '^[A-Z0-9]{1,10}$'),
  add column listing_id_digits integer not null default 2
    check (listing_id_digits between 1 and 8),
  add column listing_id_next integer not null default 1
    check (listing_id_next >= 1);

comment on column public.platform_settings.listing_id_prefix is
  'Prefix of every new listing ID (HKLS in HKLS01). Existing listings keep the code they were given.';
comment on column public.platform_settings.listing_id_digits is
  'Minimum digits of the number in a listing ID (2 gives HKLS01; the number simply grows past 99).';
comment on column public.platform_settings.listing_id_next is
  'The number the next listing gets. Moves up by one for every code handed out; the team can set it.';

alter table public.locations add column listing_code text;

alter table public.locations
  add constraint locations_listing_code_format
  check (listing_code is null or listing_code ~ '^[A-Z0-9][A-Z0-9-]{1,19}$');

-- Hands out the next free code. Row-locks the settings row, so two listings created at the same moment
-- can never get the same number; a code already in use (for instance one the team typed in by hand) is
-- skipped.
create function public.next_listing_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  _prefix text;
  _digits integer;
  _n integer;
  _code text;
  _attempt integer := 0;
begin
  loop
    _attempt := _attempt + 1;
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

    -- lpad() truncates longer text (lpad('100', 2, '0') = '10'), so only pad shorter numbers.
    -- Corrected here before this reached production; 20261123150000 applies it where it already ran.
    _code := _prefix || case when length(_n::text) < _digits then lpad(_n::text, _digits, '0') else _n::text end;
    exit when not exists (select 1 from public.locations where upper(listing_code) = upper(_code));
  end loop;
  return _code;
end;
$$;

revoke all on function public.next_listing_code() from public, anon, authenticated;
grant execute on function public.next_listing_code() to service_role;

create function public.set_location_listing_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.listing_code is null then
    new.listing_code := public.next_listing_code();
  else
    new.listing_code := upper(new.listing_code);
  end if;
  return new;
end;
$$;

revoke all on function public.set_location_listing_code() from public, anon, authenticated;

create trigger locations_set_listing_code
  before insert on public.locations
  for each row execute function public.set_location_listing_code();

-- Number the listings that already exist, oldest first (without touching updated_at).
alter table public.locations disable trigger set_locations_updated_at;
do $$
declare
  r record;
begin
  for r in select id from public.locations where listing_code is null order by created_at, id loop
    update public.locations set listing_code = public.next_listing_code() where id = r.id;
  end loop;
end;
$$;
alter table public.locations enable trigger set_locations_updated_at;

alter table public.locations alter column listing_code set not null;
create unique index locations_listing_code_key on public.locations (upper(listing_code));

comment on column public.locations.listing_code is
  'Internal listing ID, e.g. HKLS01. Shown only to the host and the team. Not readable by anon/authenticated.';

-- 2 + 3 + 4. Details, custom points and props on the listing -----------------------------------------

alter table public.locations
  add column area_sqft integer
    check (area_sqft is null or area_sqft between 1 and 10000000),
  add column set_count integer
    check (set_count is null or set_count between 0 and 200),
  add column parking_spaces integer
    check (parking_spaces is null or parking_spaces between 0 and 1000),
  add column restroom_count integer
    check (restroom_count is null or restroom_count between 0 and 100),
  add column electricity text
    check (electricity is null or electricity in ('included', 'extra', 'not_available')),
  add column permission_needed boolean,
  add column permission_details text
    check (permission_details is null or char_length(permission_details) <= 500),
  add column custom_amenities text[] not null default '{}'
    check (cardinality(custom_amenities) <= 20),
  add column custom_rules text[] not null default '{}'
    check (cardinality(custom_rules) <= 20),
  add column props jsonb not null default '[]'::jsonb
    check (jsonb_typeof(props) = 'array' and jsonb_array_length(props) <= 40);

comment on column public.locations.area_sqft is 'Floor area in square feet.';
comment on column public.locations.set_count is 'How many separate sets the listing has.';
comment on column public.locations.parking_spaces is 'Parking spaces for the crew (0 = none).';
comment on column public.locations.restroom_count is 'Number of restrooms.';
comment on column public.locations.electricity is
  'included = in the booking price; extra = charged on top; not_available = no mains power. NULL = not said.';
comment on column public.locations.permission_needed is
  'true = a permission is needed (society NOC, owner, local authority...); false = none; NULL = not said.';
comment on column public.locations.custom_amenities is 'Free-text amenity points the host or team added.';
comment on column public.locations.custom_rules is 'Free-text house rules the host or team added.';
comment on column public.locations.props is
  'List of {name, kind: included|addon, price_minor_units, price_unit: per_booking|per_hour|per_day, note}.';

-- Who can read and write the new columns (see the grants in 20261118150000: a column added to
-- `locations` is not readable by anon/authenticated until it is granted). listing_code is deliberately
-- left out: the team and the backend read it with the service role.
grant select (
  area_sqft, set_count, parking_spaces, restroom_count, electricity,
  permission_needed, permission_details, custom_amenities, custom_rules, props
) on public.locations to anon, authenticated;

grant insert (
  area_sqft, set_count, parking_spaces, restroom_count, electricity,
  permission_needed, permission_details, custom_amenities, custom_rules, props
) on public.locations to authenticated;

grant update (
  area_sqft, set_count, parking_spaces, restroom_count, electricity,
  permission_needed, permission_details, custom_amenities, custom_rules, props
) on public.locations to authenticated;

-- The amenities catalogue: tick-box amenities and allowed-here rules, in groups ---------------------

alter table public.amenities
  add column kind text not null default 'amenity' check (kind in ('amenity', 'rule')),
  add column group_name text check (group_name is null or char_length(group_name) <= 60),
  add column position integer not null default 0;

insert into public.amenities (name, kind, group_name, position) values
  ('Vanity room',                 'amenity', 'Rooms and facilities', 20),
  ('Changing room',               'amenity', 'Rooms and facilities', 30),
  ('Crew rest area',              'amenity', 'Rooms and facilities', 60),
  ('Storage space',               'amenity', 'Rooms and facilities', 70),
  ('Drinking water',              'amenity', 'Rooms and facilities', 80),
  ('Furnished',                   'amenity', 'Rooms and facilities', 90),
  ('Power backup',                'amenity', 'Power and internet',   20),
  ('Three-phase power',           'amenity', 'Power and internet',   30),
  ('Blackout curtains',           'amenity', 'Light and sound',      20),
  ('Lighting or rigging points',  'amenity', 'Light and sound',      40),
  ('Cyclorama wall',              'amenity', 'Light and sound',      50),
  ('Lift',                        'amenity', 'Access and parking',   20),
  ('Loading access',              'amenity', 'Access and parking',   30),
  ('Truck access',                'amenity', 'Access and parking',   40),
  ('Wheelchair access',           'amenity', 'Access and parking',   50),
  ('Security on site',            'amenity', 'Access and parking',   60),
  ('Outside catering allowed',        'rule', 'Allowed here', 10),
  ('Alcohol allowed',                 'rule', 'Allowed here', 20),
  ('Smoking allowed',                 'rule', 'Allowed here', 30),
  ('Pets allowed',                    'rule', 'Allowed here', 40),
  ('Night shoots allowed',            'rule', 'Allowed here', 50),
  ('Drone shots allowed',             'rule', 'Allowed here', 60),
  ('Smoke or fog effects allowed',    'rule', 'Allowed here', 70),
  ('Rearranging furniture allowed',   'rule', 'Allowed here', 80),
  ('Set construction allowed',        'rule', 'Allowed here', 90),
  ('Loud music allowed',              'rule', 'Allowed here', 100)
on conflict (name) do nothing;

-- The amenities that already existed.
update public.amenities set group_name = 'Rooms and facilities', position = 10  where name = 'Green Room' and group_name is null;
update public.amenities set group_name = 'Rooms and facilities', position = 40  where name = 'Restroom' and group_name is null;
update public.amenities set group_name = 'Rooms and facilities', position = 50  where name = 'Kitchen' and group_name is null;
update public.amenities set group_name = 'Power and internet',   position = 10  where name = 'Power' and group_name is null;
update public.amenities set group_name = 'Power and internet',   position = 40  where name = 'Wi-Fi' and group_name is null;
update public.amenities set group_name = 'Power and internet',   position = 50  where name = 'Air Conditioning' and group_name is null;
update public.amenities set group_name = 'Light and sound',      position = 10  where name = 'Natural Light' and group_name is null;
update public.amenities set group_name = 'Light and sound',      position = 30  where name = 'Sound Control' and group_name is null;
update public.amenities set group_name = 'Access and parking',   position = 10  where name = 'Parking' and group_name is null;

create index amenities_kind_position_idx on public.amenities (kind, position);

-- 5. Search ---------------------------------------------------------------------------------------

drop function public.search_locations(
  text, text, text, text, uuid[], uuid[], uuid[], integer, integer,
  double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  text, integer, integer,
  integer, integer
);

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
  _price_max integer default null,
  _parking_min integer default null,
  _area_min integer default null,
  _restrooms_min integer default null,
  _sets_min integer default null,
  _electricity_included boolean default null,
  _no_permission boolean default null,
  _has_props boolean default null
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
  area_sqft integer,
  set_count integer,
  parking_spaces integer,
  restroom_count integer,
  electricity text,
  permission_needed boolean,
  props_count integer,
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
set search_path = public, extensions
as $$
  -- Only columns anon can read: latitude/longitude here are the approximate public point (the
  -- real one when the team marked the listing "show exact location"). Distances and the radius
  -- filter use the same point, so they can't be used to find the real spot either.
  with filtered as (
    select
      l.id, l.title, l.description, l.city, l.region, l.country, l.area,
      l.public_latitude, l.public_longitude, l.public_point, l.show_exact_location,
      l.capacity, l.area_sqft, l.set_count, l.parking_spaces, l.restroom_count,
      l.electricity, l.permission_needed, jsonb_array_length(l.props) as props_count,
      l.price_on_request, l.search_vector, l.created_at,
      case when l.price_on_request then null else lp.lowest end as lowest_price
    from public.locations l
    left join lateral (
      select min(p.amount_minor_units) as lowest
      from public.location_pricing p
      where p.location_id = l.id
        and p.is_active
        and p.amount_minor_units > 0
        and p.currency = 'INR'
    ) lp on true
    where l.status = 'published'
      and (_search is null or l.search_vector @@ websearch_to_tsquery('english', _search))
      -- A city is matched by its first part, so "Mohali" and "Mohali, Punjab" are one city.
      and (_city is null or lower(trim(split_part(l.city, ',', 1))) = lower(trim(split_part(_city, ',', 1))))
      and (_region is null or lower(l.region) = lower(_region))
      and (_country is null or lower(l.country) = lower(_country))
      and (_capacity_min is null or l.capacity >= _capacity_min)
      and (_capacity_max is null or l.capacity <= _capacity_max)
      and (_parking_min is null or l.parking_spaces >= _parking_min)
      and (_area_min is null or l.area_sqft >= _area_min)
      and (_restrooms_min is null or l.restroom_count >= _restrooms_min)
      and (_sets_min is null or l.set_count >= _sets_min)
      and (_electricity_included is not true or l.electricity = 'included')
      and (_no_permission is not true or l.permission_needed = false)
      and (_has_props is not true or jsonb_array_length(l.props) > 0)
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
          and lp.lowest is not null
          and (_price_min is null or lp.lowest >= _price_min)
          and (_price_max is null or lp.lowest <= _price_max)
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
    f.area_sqft,
    f.set_count,
    f.parking_spaces,
    f.restroom_count,
    f.electricity,
    f.permission_needed,
    f.props_count,
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
    (case when _sort = 'price_asc' then f.lowest_price end) asc nulls last,
    (case when _sort = 'price_desc' then f.lowest_price end) desc nulls last,
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
  integer, integer,
  integer, integer, integer, integer, boolean, boolean, boolean
) to anon, authenticated;

-- The cities (and the shoot types in each) that have published listings: the website builds its city
-- pages from this, and only for places that have something to show. "Mohali" and "Mohali, Punjab"
-- count as one city (the part before the first comma).
create function public.published_city_pages()
returns table (city text, listing_count bigint, shoots jsonb)
language sql
security invoker
stable
set search_path = public, extensions
as $$
  with cities as (
    select lower(trim(split_part(l.city, ',', 1))) as key, min(trim(split_part(l.city, ',', 1))) as city, count(*) as n
    from public.locations l
    where l.status = 'published' and trim(split_part(l.city, ',', 1)) <> ''
    group by 1
  ),
  shoots as (
    select lower(trim(split_part(l.city, ',', 1))) as key, u.id, u.name, count(distinct l.id) as n
    from public.locations l
    join public.location_use_cases luc on luc.location_id = l.id
    join public.use_cases u on u.id = luc.use_case_id
    where l.status = 'published' and trim(split_part(l.city, ',', 1)) <> ''
    group by 1, 2, 3
  )
  select
    c.city,
    c.n as listing_count,
    coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object('id', s.id, 'name', s.name, 'listing_count', s.n)
                 order by s.n desc, s.name
               )
        from shoots s
        where s.key = c.key
      ),
      '[]'::jsonb
    ) as shoots
  from cities c
  order by c.n desc, c.city;
$$;

grant execute on function public.published_city_pages() to anon, authenticated;

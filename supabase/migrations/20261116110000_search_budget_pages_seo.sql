-- Website (Console 3, part 2): budget search, editable site pages, SEO overrides.
--
--  * search_locations(): two optional parameters, _price_min / _price_max (INR minor units), for
--    the website's "Budget" search. They filter on the listing's lowest active INR price, which is
--    exactly what listing cards show as "Starting from". Existing callers are unaffected: both
--    default to null. Recreated (not overloaded) so PostgREST never sees two candidates.
--  * site_pages: the website's editable pages (About, Contact, Privacy, Terms, Refund policy, Host
--    terms, Grievance redressal), managed in the admin console. Seeded with DRAFT text flagged
--    needs_review -- they must be reviewed by a lawyer before launch. Text may use {{brand}} and
--    {{support_email}}, filled in by the website so the product name is never hardcoded.
--  * seo_overrides: optional title / description / share image / noindex per page, listing,
--    collection, use case or category. When absent, the website writes them automatically.
--  * site_settings.support_email: the contact address the website shows (footer, pages), set in
--    the admin console instead of a deploy-time variable.
--  * admin_audit_log: widened for page and SEO edits.

drop function public.search_locations(
  text, text, text, text, uuid[], uuid[], uuid[], integer, integer,
  double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  text, integer, integer
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
  _price_max integer default null
)
returns table (
  id uuid,
  title text,
  excerpt text,
  city text,
  region text,
  country text,
  latitude double precision,
  longitude double precision,
  capacity integer,
  distance_km double precision,
  categories jsonb,
  use_cases jsonb,
  primary_media_key text,
  starting_price jsonb,
  created_at timestamptz,
  total_count bigint
)
language sql
security invoker
stable
as $$
  with filtered as (
    select l.*
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
          l.location_point is not null
          and extensions.ST_DWithin(
            l.location_point,
            extensions.ST_SetSRID(extensions.ST_MakePoint(_lng, _lat), 4326)::extensions.geography,
            _radius_km * 1000
          )
        )
      )
      and (
        _north is null or (
          l.latitude between _south and _north and l.longitude between _west and _east
        )
      )
      -- Budget (website search): the lowest active INR price -- the same number cards show as
      -- "Starting from" -- must fall inside the range.
      and (
        (_price_min is null and _price_max is null) or exists (
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
  select
    f.id,
    f.title,
    left(f.description, 240) as excerpt,
    f.city,
    f.region,
    f.country,
    f.latitude,
    f.longitude,
    f.capacity,
    case
      when _lat is not null then
        extensions.ST_Distance(
          f.location_point,
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
        and lm.section_id is null   -- Phase 29.6: general gallery only
      order by lm.position asc
      limit 1
    ) as primary_media_key,
    -- Every column is qualified with `p.`/`t.`: the RETURNS TABLE output names
    -- above are in scope in this body, and `currency` would otherwise be
    -- ambiguous against locations.currency, which phase 6a left in place.
    (
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
        -- NULL for every row when the location mixes currencies, so they all
        -- tie here and the unit order below is what actually decides.
        case when t.single_currency then t.amount_minor_units end asc nulls last,
        case t.booking_type
          when 'hourly'    then 1
          when 'half_day'  then 2
          when 'day'       then 3
          when 'multi_day' then 4
        end asc
      limit 1
    ) as starting_price,
    f.created_at,
    count(*) over () as total_count
  from filtered f
  order by
    (case when _sort = 'nearest' and _lat is not null then
      extensions.ST_Distance(
        f.location_point,
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

-- Re-grant: DROP FUNCTION discarded the previous ACL.
grant execute on function public.search_locations(
  text, text, text, text, uuid[], uuid[], uuid[], integer, integer,
  double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  text, integer, integer,
  integer, integer
) to anon, authenticated;

-- Contact email -----------------------------------------------------------------------------------

alter table public.site_settings
  add column support_email text
    check (support_email is null or (length(support_email) <= 254 and support_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));

-- Site pages -------------------------------------------------------------------------------------

create table public.site_pages (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  title text not null check (length(title) between 1 and 120),
  body text not null default '' check (length(body) <= 100000),
  placement text not null default 'legal' check (placement in ('company', 'legal', 'support', 'hidden')),
  position integer not null default 0,
  is_published boolean not null default false,
  needs_review boolean not null default false,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.site_pages is
  'Editable website pages (policies, about, contact). Service role only; published ones are served by GET /v1/site-pages.';

alter table public.site_pages enable row level security;
create trigger site_pages_set_updated_at before update on public.site_pages
  for each row execute function public.set_updated_at();

-- SEO overrides ----------------------------------------------------------------------------------

create table public.seo_overrides (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('page', 'location', 'collection', 'use_case', 'category')),
  entity_key text not null check (length(entity_key) between 1 and 80),
  meta_title text check (meta_title is null or length(meta_title) between 1 and 120),
  meta_description text check (meta_description is null or length(meta_description) between 1 and 320),
  og_image_url text check (og_image_url is null or og_image_url ~ '^https://'),
  noindex boolean not null default false,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_type, entity_key)
);

comment on table public.seo_overrides is
  'Optional SEO title/description/share image/noindex per website page or entity. Service role only.';

alter table public.seo_overrides enable row level security;
create trigger seo_overrides_set_updated_at before update on public.seo_overrides
  for each row execute function public.set_updated_at();

-- Seed pages: DRAFT text. Bracketed values such as [Company legal name] are placeholders the admin
-- console flags until they are replaced. needs_review stays true until an admin marks the page as
-- reviewed. Published so the website footer works on staging; unpublish any page in the console.

insert into public.site_pages (slug, title, placement, position, is_published, needs_review, body) values
('about', 'About us', 'company', 10, true, true, $md$
{{brand}} is a marketplace for shoot locations. Production teams, photographers and creators find homes, studios, cafés, rooftops, offices and outdoor spaces that are ready for a shoot, and book them directly from the people who own them.

## What we do

- **For bookers** — browse real spaces with photos, prices and house rules, check open dates, and book in a few steps.
- **For hosts** — list a space once, set your own prices and timings, and earn from shoots on your terms.

## Why we built it

Finding a location used to mean phone calls, scouts and guesswork. {{brand}} puts the whole process — discovery, availability, booking and payment — in one place, so teams spend less time searching and more time shooting.

## Get in touch

Questions, partnerships or press: write to [{{support_email}}](mailto:{{support_email}}).
$md$),
('contact', 'Contact us', 'company', 20, true, true, $md$
We are happy to help with bookings, listings and anything else about {{brand}}.

## Support

- **Email:** [{{support_email}}](mailto:{{support_email}})
- **Hours:** [Monday to Saturday, 10:00 to 19:00 IST]

Please include your booking reference (if you have one) so we can help faster.

## Registered office

[Company legal name]
[Registered address]

## Complaints

If your issue is not resolved, see our [Grievance redressal](/grievance-redressal) page.
$md$),
('help', 'Help centre', 'company', 30, true, true, $md$
## Booking a location

**Do I need an account to browse?**
No. Anyone can browse locations and prices. You need to log in to check open dates and to book.

**How is the price worked out?**
Each location sets its own prices — per hour, half day, full day or multiple days. The "Starting from" price on a card is the lowest of these. Your total, including any platform fee and taxes, is shown before you pay.

**When is my booking confirmed?**
After payment, the host confirms your booking. You will get a notification and an email when it is confirmed.

**Can I cancel?**
Yes. See our [Cancellation & refund policy](/refund-policy) for what you get back and when.

## Hosting

**How do I list my space?**
Choose **List your location**, create an account and add your space's photos, prices and timings. Our team reviews every listing before it goes live.

**When do I get paid?**
See the [Host terms](/host-terms) for payout timelines.

## Still need help?

Write to [{{support_email}}](mailto:{{support_email}}).
$md$),
('grievance-redressal', 'Grievance redressal', 'company', 40, true, true, $md$
In line with the Information Technology Act, 2000, the rules made under it, and the Consumer Protection (E-Commerce) Rules, 2020, {{brand}} has appointed a Grievance Officer.

## Grievance Officer

- **Name:** [Grievance officer name]
- **Designation:** [Designation]
- **Email:** [grievance email address]
- **Address:** [Registered address]

## How to raise a grievance

Email the Grievance Officer with:

1. Your name and the email or phone number on your account
2. Your booking reference or the listing concerned, if any
3. A description of the issue and any supporting screenshots or documents

## What happens next

We will acknowledge your complaint within [48 hours] and aim to resolve it within [one month] of receiving it. We will keep you informed if we need more information.
$md$),
('terms', 'Terms & conditions', 'legal', 10, true, true, $md$
_Last updated: [date]_

These terms govern your use of the {{brand}} website and apps (the "Platform"), operated by [Company legal name] ("we", "us"). By using the Platform you agree to them.

## 1. What {{brand}} is

{{brand}} is a marketplace. Hosts list spaces; bookers book them for shoots. We are not a party to the agreement between a booker and a host, but we run the Platform, process payments and help resolve issues.

## 2. Your account

- You must be at least 18 years old and able to enter into a binding contract.
- Keep your login details safe. You are responsible for activity on your account.
- Information you give us must be accurate and kept up to date.

## 3. Bookings

- A booking is a request until the host confirms it.
- Prices, fees and taxes are shown before you pay. The amount shown at checkout is the amount charged.
- You must use the space only for the shoot described, within the booked time, and follow the host's house rules.
- You are responsible for your crew, equipment and any damage caused during your booking.

## 4. Payments

Payments are processed by our payment partner. We may hold payments until a booking is complete. Refunds follow our [Cancellation & refund policy](/refund-policy).

## 5. Hosts

Hosts must also follow the [Host terms](/host-terms). Hosts are responsible for the accuracy of their listings and for having the rights and permissions to rent their space.

## 6. Content

You keep ownership of content you upload, and give us a licence to display it on the Platform and in our marketing. Do not upload anything unlawful, misleading or that infringes someone else's rights.

## 7. Prohibited use

Do not misuse the Platform — for example by scraping it, interfering with its security, avoiding fees by paying hosts outside the Platform, or using it for unlawful activity.

## 8. Suspension

We may suspend or remove accounts or listings that break these terms or put others at risk.

## 9. Liability

To the extent allowed by law, we are not liable for indirect or consequential losses, or for the conduct of hosts or bookers. Nothing in these terms limits liability that cannot be limited by law.

## 10. Changes

We may update these terms. We will post the new version here with its date; continuing to use the Platform means you accept it.

## 11. Governing law

These terms are governed by the laws of India. Courts at [City] have jurisdiction.

## 12. Contact

[{{support_email}}](mailto:{{support_email}}) · [Grievance redressal](/grievance-redressal)
$md$),
('privacy', 'Privacy policy', 'legal', 20, true, true, $md$
_Last updated: [date]_

This policy explains what personal data [Company legal name] ("{{brand}}", "we") collects, why, and the choices you have. It is written to meet the Digital Personal Data Protection Act, 2023 and the Information Technology Act, 2000.

## What we collect

- **Account details** — name, email address, phone number and profile photo.
- **Booking details** — the locations you book, dates, crew size, messages with hosts, and billing details such as GST number where you provide them.
- **Payment information** — handled by our payment partner. We receive the payment status and reference, not your full card or bank details.
- **Host details** — listing information, photos, address of the space and payout details.
- **Usage and device data** — pages viewed, approximate location from your IP address (to show nearby locations), device type, and notification tokens if you enable notifications.
- **Precise location** — only if you choose "Use my location", and only to search near you.

## Why we use it

To create and secure your account, run bookings and payments, connect bookers with hosts, send booking updates, provide support, prevent fraud, meet legal obligations, and improve the Platform. We send marketing messages only where you have agreed and you can opt out any time.

## Who we share it with

- The other party to your booking (for example, a host sees the booker's name and booking details).
- Service providers who run the Platform for us: hosting, database and storage, payments, email and notifications, and maps. They may process data only on our instructions.
- Authorities, where the law requires it.

We do not sell your personal data.

## How long we keep it

As long as your account is active and afterwards as long as needed for legal, tax and dispute purposes — typically [8 years] for booking and payment records.

## Your rights

You can access, correct or delete your personal data, withdraw consent, and nominate someone to exercise your rights. Write to [{{support_email}}](mailto:{{support_email}}). If you are not satisfied, contact our [Grievance Officer](/grievance-redressal).

## Cookies and local storage

We use essential cookies and browser storage to keep you signed in and remember your preferences. [Describe analytics cookies if any are added.]

## Security

We use encryption in transit, access controls and audited admin access. No system is perfectly secure; tell us at once if you suspect misuse of your account.

## Changes

We will post updates here with a new date.
$md$),
('refund-policy', 'Cancellation & refund policy', 'legal', 30, true, true, $md$
_Last updated: [date]_

## Cancellations by the booker

| When you cancel | Refund |
| --- | --- |
| More than [7 days] before the shoot | [Full refund of the booking amount] |
| [2 to 7 days] before the shoot | [50% of the booking amount] |
| Less than [48 hours] before the shoot | [No refund] |

Platform fees are [non-refundable / refunded in full]. Taxes are refunded in proportion to the amount refunded.

## Cancellations by the host

If a host cancels a confirmed booking, you get a **full refund**, including fees. We will also try to help you find a similar location.

## Unpaid bookings

A booking that is not paid within the time shown at checkout is cancelled automatically. Nothing is charged.

## If something goes wrong

If the space is significantly different from its listing, or you cannot get access at the booked time, contact us within [24 hours] at [{{support_email}}](mailto:{{support_email}}) with photos or details. We will review it and may issue a full or partial refund.

## How refunds are paid

Refunds go back to the original payment method. Once we issue a refund it usually reaches you in [5 to 7 working days], depending on your bank.
$md$),
('host-terms', 'Host terms', 'legal', 40, true, true, $md$
_Last updated: [date]_

These terms apply to everyone who lists a space on {{brand}}, in addition to our [Terms & conditions](/terms).

## Listing your space

- You must own the space or have the right to rent it out for shoots, including any permissions required by your society, landlord or local authority.
- Photos, descriptions, prices, timings and house rules must be accurate and kept up to date.
- Every listing is reviewed before it goes live. We may decline or remove listings that do not meet our standards.

## Bookings

- Respond to booking requests promptly and honour confirmed bookings.
- If you must cancel, do it as early as possible. Bookers get a full refund when a host cancels, and repeated cancellations may lead to your listing being suspended.

## Fees and payouts

- {{brand}} charges a platform fee of [x%] on each booking. The current fee is shown in your host dashboard.
- Payouts are made to your registered bank account within [7 working days] after the booking is completed, less fees and any applicable taxes or deductions.
- You are responsible for your own taxes, including GST registration where required.

## Safety and damage

Agree house rules with bookers in advance. Report any damage within [48 hours] of the booking ending, with photos, so we can help resolve it.

## Ending your listing

You can unlist your space at any time. Confirmed bookings must still be honoured or cancelled under these terms.
$md$)
on conflict (slug) do nothing;

-- Audit vocabulary ------------------------------------------------------------------------------

do $$
declare
  _name text;
begin
  for _name in
    select conname from pg_constraint
    where conrelid = 'public.admin_audit_log'::regclass
      and contype = 'c'
      and (pg_get_constraintdef(oid) like '%ADMIN_APPROVED_LOCATION%'
           or pg_get_constraintdef(oid) like '%target_type%')
  loop
    execute format('alter table public.admin_audit_log drop constraint %I', _name);
  end loop;
end $$;

alter table public.admin_audit_log add constraint admin_audit_log_action_check check (
  action in (
    -- Phase 11 / 12
    'ADMIN_APPROVED_LOCATION',
    'ADMIN_REJECTED_LOCATION',
    'ADMIN_SUSPENDED_LOCATION',
    'ADMIN_RESTORED_LOCATION',
    'ADMIN_UPDATED_LOCATION_STATUS',
    'ADMIN_SUSPENDED_USER',
    'ADMIN_RESTORED_USER',
    'ADMIN_CANCELLED_BOOKING',
    'ADMIN_CREATED_REFUND',
    -- Admin Console
    'ADMIN_CONFIRMED_BOOKING',
    'ADMIN_REJECTED_BOOKING',
    'ADMIN_COMPLETED_BOOKING',
    'ADMIN_VERIFIED_PAYMENT',
    'ADMIN_UPDATED_LOCATION',
    'ADMIN_DELETED_MEDIA',
    'ADMIN_DELETED_SECTION',
    'ADMIN_CREATED_CATALOG_ITEM',
    'ADMIN_UPDATED_CATALOG_ITEM',
    'ADMIN_DELETED_CATALOG_ITEM',
    'ADMIN_GRANTED_ROLE',
    'ADMIN_REVOKED_ROLE',
    'ADMIN_SET_TEAM_ROLE',
    'ADMIN_REMOVED_TEAM_MEMBER',
    'ADMIN_UPDATED_SETTINGS',
    -- Admin Console 2
    'ADMIN_CREATED_LOCATION',
    'ADMIN_UPLOADED_MEDIA',
    'ADMIN_REORDERED_MEDIA',
    'ADMIN_UPDATED_PRICING',
    'ADMIN_UPDATED_AVAILABILITY',
    'ADMIN_UPDATED_SECTION',
    'ADMIN_UPDATED_CATALOG_LISTINGS',
    'ADMIN_UPDATED_CATALOG_COVER',
    'ADMIN_CREATED_COLLECTION',
    'ADMIN_UPDATED_COLLECTION',
    'ADMIN_DELETED_COLLECTION',
    'ADMIN_SENT_CAMPAIGN',
    'ADMIN_CANCELLED_CAMPAIGN',
    'ADMIN_CONNECTED_CHANNEL',
    'ADMIN_DISCONNECTED_CHANNEL',
    'ADMIN_UPDATED_JOBS_CONFIG',
    'ADMIN_UPDATED_PLATFORM',
    'ADMIN_UPDATED_FEATURE_FLAG',
    'ADMIN_DELETED_FEATURE_FLAG',
    'ADMIN_CREATED_INCIDENT',
    'ADMIN_UPDATED_INCIDENT',
    'ADMIN_CREATED_RELEASE',
    'ADMIN_UPDATED_RELEASE',
    'ADMIN_DELETED_RELEASE',
    -- Website (Console 3)
    'ADMIN_CONNECTED_SITE_INTEGRATION',
    'ADMIN_DISCONNECTED_SITE_INTEGRATION',
    'ADMIN_ADDED_DOMAIN',
    'ADMIN_UPDATED_DOMAIN',
    'ADMIN_REMOVED_DOMAIN',
    'ADMIN_SET_PRIMARY_DOMAIN',
    -- Website pages and SEO
    'ADMIN_CREATED_PAGE',
    'ADMIN_UPDATED_PAGE',
    'ADMIN_DELETED_PAGE',
    'ADMIN_UPDATED_SEO'
  )
);

alter table public.admin_audit_log add constraint admin_audit_log_target_type_check check (
  target_type in (
    'location', 'user', 'booking', 'payment', 'media', 'section', 'catalog_item', 'settings',
    'collection', 'campaign', 'channel', 'platform', 'feature_flag', 'incident', 'release',
    'site_integration', 'site', 'site_page', 'seo'
  )
);

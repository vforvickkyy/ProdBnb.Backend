-- Notification templates and personalised bulk sends.
--
--  * notification_templates: reusable title/body (and optional email) with variables such as
--    {first_name} or {listing_title}, filled in per person when a campaign is sent. A few
--    built-in templates are seeded; the team can edit them or add their own.
--  * notification_campaigns gains the listing and/or offer a campaign is about (their details fill
--    {listing_*} and {offer_*}) and the template it started from.
--  * A new audience type, "segment": by role, profession, city, shoot type, whether they've booked,
--    and whether they want new-listing alerts (from onboarding, user_preferences). Every filter is
--    optional; filters combine with AND, the values inside one filter with OR.
--  * campaign_audience(): the one definition of who an audience is, used both by the preview
--    count and when a campaign is sent, so the two can never disagree.

create table public.notification_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  category text not null default 'custom' check (category in ('new_listing', 'new_offer', 'casual', 'reminder', 'host', 'custom')),
  description text check (description is null or char_length(description) <= 300),
  -- What the template needs picked before it can be sent: a listing, an offer, or nothing.
  needs text check (needs is null or needs in ('listing', 'offer')),
  title text not null check (char_length(title) between 1 and 160),
  body text not null check (char_length(body) between 1 and 1000),
  email_subject text check (email_subject is null or char_length(email_subject) between 1 and 200),
  email_body text check (email_body is null or char_length(email_body) <= 50000),
  channels text[] not null default '{in_app,push}' check (channels <@ array['in_app', 'push', 'email']::text[] and cardinality(channels) between 1 and 3),
  is_builtin boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.notification_templates is 'Reusable notification wording with {variables}. Service role only.';
alter table public.notification_templates enable row level security;
create trigger notification_templates_set_updated_at before update on public.notification_templates
  for each row execute function public.set_updated_at();

insert into public.notification_templates (name, category, description, needs, title, body, email_subject, email_body, channels, is_builtin) values
  ('New listing', 'new_listing', 'Tell people about a location that just went live.', 'listing',
   'New in {listing_city}: {listing_title}',
   'Hi {first_name|there}, {listing_title} is now open for bookings from {listing_price}. Have a look before the good dates go.',
   'New location in {listing_city}: {listing_title}',
   E'Hi {first_name|there},\n\n**{listing_title}** in {listing_city} just went live, from {listing_price}.\n\nTake a look and hold your dates before they go.',
   '{in_app,push}', true),
  ('Listing spotlight', 'new_listing', 'Feature one location you think people will love.', 'listing',
   '{first_name|Hey}, this one''s made for your next shoot',
   '{listing_title} in {listing_city}. Book by the hour or the day, from {listing_price}.',
   null, null, '{in_app,push}', true),
  ('New offer', 'new_offer', 'Announce a coupon or offer.', 'offer',
   '{offer_discount} on your next booking',
   'Hi {first_name|there}, {offer_title}. Use code {offer_code} at checkout{offer_ends}.',
   '{offer_discount} on your next booking',
   E'Hi {first_name|there},\n\n{offer_title}. Use code **{offer_code}** at checkout{offer_ends}.',
   '{in_app,push}', true),
  ('Casual hello', 'casual', 'A friendly nudge to come back and browse.', null,
   'Planning a shoot, {first_name|there}?',
   'Fresh locations are going up every week{city_suffix}. Find one and book it in minutes.',
   null, null, '{in_app,push}', true),
  ('Weekend reminder', 'reminder', 'Remind people to lock in weekend dates early.', null,
   'Weekend shoot coming up?',
   'Hi {first_name|there}, weekend dates go fast. Book now and keep your plans on track.',
   null, null, '{in_app,push}', true),
  ('Host tip', 'host', 'A tip for hosts to get more bookings.', null,
   'More bookings with better photos, {first_name|there}',
   'Listings with 10 or more bright, wide photos get noticeably more bookings. Add a few more to yours today.',
   null, null, '{in_app,push}', true);

alter table public.notification_campaigns
  add column location_id uuid references public.locations (id) on delete set null,
  add column coupon_id uuid references public.coupons (id) on delete set null,
  add column template_id uuid references public.notification_templates (id) on delete set null;

-- Who an audience is ------------------------------------------------------------------------------

create function public.campaign_audience(_audience jsonb, _platforms text[])
returns table (user_id uuid, email text)
language sql
security definer
set search_path = ''
stable
as $$
  select p.id, lower(u.email)
  from public.profiles p
  join auth.users u on u.id = p.id
  left join public.user_preferences pref on pref.user_id = p.id
  where p.status = 'active'
    and (
      _audience ->> 'type' = 'all'
      or (_audience ->> 'type' = 'role' and exists (
        select 1 from public.user_roles r where r.user_id = p.id and r.role = (_audience ->> 'role')
      ))
      or (_audience ->> 'type' = 'users' and p.id in (
        select value::uuid from jsonb_array_elements_text(coalesce(_audience -> 'user_ids', '[]'::jsonb))
      ))
      or (_audience ->> 'type' = 'platform_users' and exists (
        select 1 from public.user_devices d
        where d.user_id = p.id and d.is_active and d.platform = any (_platforms)
      ))
      or (
        _audience ->> 'type' = 'segment'
        and (
          _audience ->> 'role' is null
          or exists (select 1 from public.user_roles r where r.user_id = p.id and r.role = (_audience ->> 'role'))
        )
        and (
          coalesce(jsonb_array_length(_audience -> 'professions'), 0) = 0
          or pref.professions && array(select jsonb_array_elements_text(_audience -> 'professions'))
        )
        and (
          coalesce(jsonb_array_length(_audience -> 'cities'), 0) = 0
          or exists (
            select 1 from jsonb_array_elements_text(_audience -> 'cities') c(city)
            where lower(btrim(c.city)) = lower(btrim(p.address_city))
               or lower(btrim(c.city)) in (select lower(btrim(x)) from unnest(coalesce(pref.cities, '{}')) x)
          )
        )
        and (
          coalesce(jsonb_array_length(_audience -> 'use_case_ids'), 0) = 0
          or pref.use_case_ids && array(select value::uuid from jsonb_array_elements_text(_audience -> 'use_case_ids'))
        )
        and (
          _audience ->> 'booked' is null
          or (_audience ->> 'booked' = 'yes') = exists (
            select 1 from public.bookings b
            join public.payments pay on pay.booking_id = b.id and pay.status in ('success', 'partially_refunded', 'refunded')
            where b.booker_id = p.id
          )
        )
        and (
          coalesce((_audience ->> 'new_listing_alerts')::boolean, false) = false
          or coalesce(pref.new_listing_alerts, true)
        )
      )
    );
$$;

create or replace function public.campaign_expand_recipients(_campaign_id uuid) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  _c public.notification_campaigns;
  _count integer;
  _wants_in_app boolean;
begin
  select * into _c from public.notification_campaigns where id = _campaign_id for update;
  if not found then
    raise exception 'campaign_not_found';
  end if;

  -- Push needs the in-app row as its anchor (delivery attempts reference it), so either channel
  -- creates one.
  _wants_in_app := 'in_app' = any (_c.channels) or 'push' = any (_c.channels);

  insert into public.campaign_recipients (campaign_id, user_id, email, in_app_status, push_status, email_status)
  select
    _campaign_id,
    a.user_id,
    a.email,
    case when _wants_in_app then 'pending' else 'skipped' end,
    case when 'push' = any (_c.channels) then 'pending' else 'skipped' end,
    case when 'email' = any (_c.channels) then 'pending' else 'skipped' end
  from public.campaign_audience(_c.audience, _c.platforms) a
  on conflict do nothing;

  get diagnostics _count = row_count;
  update public.notification_campaigns
  set recipient_count = (select count(*) from public.campaign_recipients where campaign_id = _campaign_id)
  where id = _campaign_id;
  return _count;
end $$;

create or replace function public.admin_audience_preview(_audience jsonb, _platforms text[])
returns table (users bigint, with_email bigint, ios_devices bigint, android_devices bigint, web_devices bigint)
language sql
security definer
set search_path = ''
stable
as $$
  with audience as (select a.user_id as id, a.email from public.campaign_audience(_audience, _platforms) a)
  select
    (select count(*) from audience),
    (select count(*) from audience a where a.email is not null
       and not exists (select 1 from public.email_suppressions s where s.email = lower(a.email))),
    (select count(*) from public.user_devices d join audience a on a.id = d.user_id where d.is_active and d.platform = 'ios'),
    (select count(*) from public.user_devices d join audience a on a.id = d.user_id where d.is_active and d.platform = 'android'),
    (select count(*) from public.user_devices d join audience a on a.id = d.user_id where d.is_active and d.platform = 'web');
$$;

revoke all on function public.campaign_audience(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.campaign_expand_recipients(uuid) from public, anon, authenticated;
revoke all on function public.admin_audience_preview(jsonb, text[]) from public, anon, authenticated;
grant execute on function public.campaign_audience(jsonb, text[]) to service_role;
grant execute on function public.campaign_expand_recipients(uuid) to service_role;
grant execute on function public.admin_audience_preview(jsonb, text[]) to service_role;

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
    'ADMIN_UPDATED_SEO',
    -- Booker account
    'ADMIN_APPROVED_REFUND_REQUEST',
    'ADMIN_DECLINED_REFUND_REQUEST',
    'ADMIN_COMPLETED_ACCOUNT_DELETION',
    'ADMIN_DECLINED_ACCOUNT_DELETION',
    -- Host payouts
    'ADMIN_VIEWED_PAYOUT_DETAILS',
    'ADMIN_RECORDED_PAYOUT',
    -- Coupons
    'ADMIN_CREATED_COUPON',
    'ADMIN_UPDATED_COUPON',
    'ADMIN_DELETED_COUPON',
    -- Invoices and receipts
    'ADMIN_UPDATED_INVOICE_SETTINGS',
    'ADMIN_ISSUED_INVOICES',
    'ADMIN_SENT_INVOICE',
    'ADMIN_SENT_RECEIPT',
    -- Notification templates
    'ADMIN_CREATED_NOTIFICATION_TEMPLATE',
    'ADMIN_UPDATED_NOTIFICATION_TEMPLATE',
    'ADMIN_DELETED_NOTIFICATION_TEMPLATE'
  )
);

alter table public.admin_audit_log add constraint admin_audit_log_target_type_check check (
  target_type in (
    'location', 'user', 'booking', 'payment', 'media', 'section', 'catalog_item', 'settings',
    'collection', 'campaign', 'channel', 'platform', 'feature_flag', 'incident', 'release',
    'site_integration', 'site', 'site_page', 'seo', 'refund_request', 'deletion_request',
    'payout_account', 'payout',
    'coupon',
    'invoice',
    'notification_template'
  )
);

-- ============================================================================
-- Marketing emails: designs, tracking and subscribers.
--
-- 1. Designs. A campaign's email (and a template's) picks a design -- plain, spotlight (one
--    listing), collection (2-6 listings), offer (a coupon) or news (a picture) -- plus an optional
--    headline, picture and button label. Listings and the offer are read when the email is sent.
--
-- 2. Tracking. Each email sent through Resend has an id; Resend's webhook reports delivered,
--    opened, clicked, bounced and spam complaints against it. Campaign recipients keep the first
--    time of each (and open/click counts); transactional emails keep delivered/bounced only (opens
--    and clicks aren't tracked on booking mail).
--
-- 3. Subscribers. Who gets news and offers by email: everyone with an address that isn't on the
--    do-not-email list. Counts for the audience preview and a list for the Subscribers page.
-- ============================================================================

-- 1. Designs -------------------------------------------------------------------------------------

alter table public.notification_campaigns
  add column email_design text not null default 'plain'
    check (email_design in ('plain', 'spotlight', 'collection', 'offer', 'news')),
  add column email_heading text check (email_heading is null or char_length(email_heading) <= 200),
  add column email_image_url text
    check (email_image_url is null or (char_length(email_image_url) <= 1000 and email_image_url ~ '^https://')),
  add column email_button_label text check (email_button_label is null or char_length(email_button_label) <= 40),
  add column email_location_ids uuid[] not null default '{}' check (cardinality(email_location_ids) <= 6);

alter table public.notification_templates
  add column email_design text not null default 'plain'
    check (email_design in ('plain', 'spotlight', 'collection', 'offer', 'news')),
  add column email_heading text check (email_heading is null or char_length(email_heading) <= 200),
  add column email_image_url text
    check (email_image_url is null or (char_length(email_image_url) <= 1000 and email_image_url ~ '^https://')),
  add column email_button_label text check (email_button_label is null or char_length(email_button_label) <= 40);

-- 2. Tracking -------------------------------------------------------------------------------------

alter table public.campaign_recipients
  add column email_message_id text,
  add column email_delivered_at timestamptz,
  add column email_opened_at timestamptz,
  add column email_clicked_at timestamptz,
  add column email_open_count integer not null default 0,
  add column email_click_count integer not null default 0,
  add column email_bounced_at timestamptz,
  add column email_complained_at timestamptz;

create index campaign_recipients_email_message_idx on public.campaign_recipients (email_message_id)
  where email_message_id is not null;

alter table public.email_outbox
  add column delivered_at timestamptz,
  add column bounced_at timestamptz;

create index email_outbox_provider_message_idx on public.email_outbox (provider_message_id)
  where provider_message_id is not null;

drop function public.admin_campaign_stats(uuid[]);
create function public.admin_campaign_stats(_campaign_ids uuid[])
returns table (
  campaign_id uuid,
  total bigint,
  processed bigint,
  in_app_created bigint,
  push_sent bigint,
  push_failed bigint,
  push_no_devices bigint,
  push_opted_out bigint,
  email_sent bigint,
  email_failed bigint,
  email_unsubscribed bigint,
  email_missing bigint,
  email_delivered bigint,
  email_opened bigint,
  email_clicked bigint,
  email_bounced bigint,
  email_complained bigint
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    r.campaign_id,
    count(*),
    count(*) filter (where r.processed_at is not null),
    count(*) filter (where r.in_app_status = 'created'),
    count(*) filter (where r.push_status in ('sent', 'partial')),
    count(*) filter (where r.push_status = 'failed'),
    count(*) filter (where r.push_status = 'no_devices'),
    count(*) filter (where r.push_status = 'opted_out'),
    count(*) filter (where r.email_status = 'sent'),
    count(*) filter (where r.email_status = 'failed'),
    count(*) filter (where r.email_status = 'unsubscribed'),
    count(*) filter (where r.email_status = 'no_email'),
    count(*) filter (where r.email_delivered_at is not null),
    count(*) filter (where r.email_opened_at is not null),
    count(*) filter (where r.email_clicked_at is not null),
    count(*) filter (where r.email_bounced_at is not null),
    count(*) filter (where r.email_complained_at is not null)
  from public.campaign_recipients r
  where r.campaign_id = any (_campaign_ids)
  group by r.campaign_id;
$$;

-- 3. Subscribers ----------------------------------------------------------------------------------

drop function public.admin_audience_preview(jsonb, text[]);
create function public.admin_audience_preview(_audience jsonb, _platforms text[])
returns table (
  users bigint,
  with_email bigint,
  ios_devices bigint,
  android_devices bigint,
  web_devices bigint,
  email_unsubscribed bigint,
  email_bounced bigint,
  email_missing bigint
)
language sql
security definer
set search_path = ''
stable
as $$
  with audience as (select a.user_id as id, a.email from public.campaign_audience(_audience, _platforms) a),
  marked as (
    select a.id, a.email, s.reason
    from audience a
    left join public.email_suppressions s on s.email = lower(a.email)
  )
  select
    (select count(*) from audience),
    (select count(*) from marked where email is not null and reason is null),
    (select count(*) from public.user_devices d join audience a on a.id = d.user_id where d.is_active and d.platform = 'ios'),
    (select count(*) from public.user_devices d join audience a on a.id = d.user_id where d.is_active and d.platform = 'android'),
    (select count(*) from public.user_devices d join audience a on a.id = d.user_id where d.is_active and d.platform = 'web'),
    (select count(*) from marked where email is not null and reason in ('unsubscribed', 'admin')),
    (select count(*) from marked where email is not null and reason = 'bounced'),
    (select count(*) from marked where email is null);
$$;

/** Everyone active, with whether news and offers reach them by email. */
create function public.admin_email_subscribers(
  _status text,
  _role text,
  _search text,
  _limit integer,
  _offset integer
)
returns table (
  user_id uuid,
  name text,
  email text,
  roles text[],
  status text,
  status_since timestamptz,
  joined_at timestamptz,
  total_count bigint
)
language sql
security definer
set search_path = ''
stable
as $$
  with people as (
    select
      p.id,
      nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '') as name,
      u.email,
      coalesce((select array_agg(r.role order by r.role) from public.user_roles r where r.user_id = p.id), '{}') as roles,
      case
        when u.email is null then 'no_email'
        when s.reason = 'bounced' then 'bounced'
        when s.reason is not null then 'unsubscribed'
        else 'subscribed'
      end as status,
      s.created_at as status_since,
      p.created_at as joined_at
    from public.profiles p
    join auth.users u on u.id = p.id
    left join public.email_suppressions s on s.email = lower(u.email)
    where p.status = 'active'
  ),
  filtered as (
    select * from people
    where (_status is null or status = _status)
      and (_role is null or _role = any (roles))
      and (
        _search is null
        or email ilike '%' || _search || '%'
        or name ilike '%' || _search || '%'
      )
  )
  select f.id, f.name, f.email, f.roles, f.status, f.status_since, f.joined_at, count(*) over ()
  from filtered f
  order by f.joined_at desc
  limit greatest(1, least(_limit, 100)) offset greatest(0, _offset);
$$;

create function public.admin_email_subscriber_summary()
returns table (people bigint, subscribed bigint, unsubscribed bigint, bounced bigint, no_email bigint,
  hosts_subscribed bigint, bookers_subscribed bigint)
language sql
security definer
set search_path = ''
stable
as $$
  with people as (
    select
      p.id,
      case
        when u.email is null then 'no_email'
        when s.reason = 'bounced' then 'bounced'
        when s.reason is not null then 'unsubscribed'
        else 'subscribed'
      end as status
    from public.profiles p
    join auth.users u on u.id = p.id
    left join public.email_suppressions s on s.email = lower(u.email)
    where p.status = 'active'
  )
  select
    count(*),
    count(*) filter (where status = 'subscribed'),
    count(*) filter (where status = 'unsubscribed'),
    count(*) filter (where status = 'bounced'),
    count(*) filter (where status = 'no_email'),
    count(*) filter (where status = 'subscribed' and exists (select 1 from public.user_roles r where r.user_id = people.id and r.role = 'host')),
    count(*) filter (where status = 'subscribed' and exists (select 1 from public.user_roles r where r.user_id = people.id and r.role = 'booker'))
  from people;
$$;

revoke all on function public.admin_campaign_stats(uuid[]) from public, anon, authenticated;
revoke all on function public.admin_audience_preview(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.admin_email_subscribers(text, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_email_subscriber_summary() from public, anon, authenticated;
grant execute on function public.admin_campaign_stats(uuid[]) to service_role;
grant execute on function public.admin_audience_preview(jsonb, text[]) to service_role;
grant execute on function public.admin_email_subscribers(text, text, text, integer, integer) to service_role;
grant execute on function public.admin_email_subscriber_summary() to service_role;

-- 4. Ready-made marketing email templates (one per design) ----------------------------------------

insert into public.notification_templates
  (name, category, description, needs, title, body, email_subject, email_body, channels, email_design, email_heading, email_button_label, is_builtin)
values
  ('Listing spotlight (email)', 'new_listing',
   'One place, big: photo, facts, price and a button to its page.', 'listing',
   'Spotlight: {listing_title}', '{listing_title} in {listing_city}, from {listing_price}.',
   'Spotlight: {listing_title} in {listing_city}',
   E'Hi {first_name|there},\n\nThis week''s pick for your next shoot. Have a look before the good dates go.',
   '{email}', 'spotlight', '{listing_title}', 'See this place', true),
  ('Listing collection (email)', 'casual',
   'A handful of places as a grid, e.g. "Rooftops in Mumbai". Pick 2–6 listings when sending.', null,
   'Places picked for your next shoot', 'A few places we think you''ll like.',
   '{first_name|Hey}, places picked for your next shoot',
   E'Hi {first_name|there},\n\nWe picked a few places{city_suffix} that are great for shoots right now.',
   '{email}', 'collection', 'Places picked for you', 'See more places', true),
  ('Offer with code (email)', 'new_offer',
   'A coupon code box with what it gives and until when.', 'offer',
   '{offer_discount} on your next booking', 'Use code {offer_code} at checkout{offer_ends}.',
   '{offer_discount} on your next booking',
   E'Hi {first_name|there},\n\n{offer_title}. Use the code below at checkout{offer_ends}.',
   '{email}', 'offer', '{offer_discount} on your next booking', 'Find a place', true),
  ('News or host tips (email)', 'host',
   'A wide picture, a headline, your message and a button. For updates, new features and host tips.', null,
   'News from the team', 'Something new for you.',
   'News from the team',
   E'Hi {first_name|there},\n\nWrite your update here. Keep it short: one idea, one button.',
   '{email}', 'news', 'Something new for you', 'Read more', true);

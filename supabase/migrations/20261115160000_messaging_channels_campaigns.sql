-- Admin Console 2: messaging channels (email + push credentials) and announcement campaigns.
--
-- 1. messaging_channels -- one row per sending channel (smtp, apns, fcm, webpush). Non-secret
--    settings (SMTP host, APNs key id, FCM project id, the VAPID public key...) live in `config`;
--    the SECRET part (SMTP password, .p8 key, service-account JSON, VAPID private key) lives in
--    Supabase Vault, encrypted at rest, and is referenced here only by its vault id. The helper
--    functions below are the only way in or out, and only service_role may call them -- the API
--    writes a secret, and never returns one.
--
-- 2. notification_campaigns + campaign_recipients -- an announcement, or a direct message to
--    chosen users, sent over any mix of in-app / push / email. Recipients are expanded once, in
--    SQL, then processed in small leased batches by the backend dispatcher, so a send to every
--    user never has to fit inside one serverless request.
--
-- 3. email_suppressions -- addresses that unsubscribed (or bounced). Every announcement email
--    carries a signed one-click unsubscribe link.
--
-- 4. background_jobs_config + dispatch_background_jobs() -- pg_cron ticks every minute and, when
--    there is campaign work, POSTs the backend's dispatcher through pg_net with a shared secret
--    (also kept in Vault). Off until an admin enables it with the backend URL.
--
-- 5. Notification vocabulary: type/entity_type 'announcement', preference category
--    'announcement', delivery providers 'fcm' and 'webpush', and device metadata for Android/Web.

-- ============================================================================
-- 0. Extensions (guarded: pg_net is optional; without it campaigns still send while an admin has
--    the campaign page open, and scheduled sends wait until it is enabled)
-- ============================================================================

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
exception when others then
  raise notice 'pg_net not enabled: %', sqlerrm;
end $$;

-- ============================================================================
-- 1. messaging_channels
-- ============================================================================

create table public.messaging_channels (
  id uuid primary key default gen_random_uuid(),
  channel text not null unique check (channel in ('smtp', 'apns', 'fcm', 'webpush')),
  config jsonb not null default '{}'::jsonb,
  secret_id uuid,
  enabled boolean not null default true,
  last_tested_at timestamptz,
  last_test_ok boolean,
  last_test_error text check (last_test_error is null or char_length(last_test_error) <= 1000),
  connected_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.messaging_channels is
  'Sending channel configuration. Secrets are in Supabase Vault (secret_id); config holds only '
  'non-secret settings. Service-role only; written via /v1/admin/messaging/channels.';

create trigger set_messaging_channels_updated_at
  before update on public.messaging_channels
  for each row execute function public.set_updated_at();

alter table public.messaging_channels enable row level security;
revoke all on public.messaging_channels from anon, authenticated;
grant select, insert, update, delete on public.messaging_channels to service_role;

-- Store (create or replace) a channel's secret in Vault and its non-secret config in one step.
create function public.messaging_channel_save(
  _channel text,
  _config jsonb,
  _secret text,
  _actor_id uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  _row public.messaging_channels;
  _secret_id uuid;
  _name text := 'prodbnb_channel_' || _channel;
begin
  if _channel not in ('smtp', 'apns', 'fcm', 'webpush') then
    raise exception 'invalid_channel';
  end if;

  select * into _row from public.messaging_channels where channel = _channel for update;
  _secret_id := _row.secret_id;

  if _secret is not null then
    if _secret_id is null then
      select id into _secret_id from vault.secrets where name = _name;
    end if;
    if _secret_id is null then
      _secret_id := vault.create_secret(_secret, _name, 'ProdBnb messaging channel credential');
    else
      perform vault.update_secret(_secret_id, _secret, _name, 'ProdBnb messaging channel credential');
    end if;
  end if;

  if _row.id is null then
    if _secret_id is null then
      raise exception 'secret_required';
    end if;
    insert into public.messaging_channels (channel, config, secret_id, connected_by)
    values (_channel, coalesce(_config, '{}'::jsonb), _secret_id, _actor_id)
    returning * into _row;
  else
    update public.messaging_channels
    set config = coalesce(_config, config),
        secret_id = _secret_id,
        enabled = true,
        connected_by = _actor_id,
        last_tested_at = null,
        last_test_ok = null,
        last_test_error = null
    where id = _row.id
    returning * into _row;
  end if;

  return _row.id;
end $$;

create function public.messaging_channel_secret(_channel text) returns text
language sql
security definer
set search_path = ''
stable
as $$
  select ds.decrypted_secret
  from public.messaging_channels mc
  join vault.decrypted_secrets ds on ds.id = mc.secret_id
  where mc.channel = _channel;
$$;

create function public.messaging_channel_remove(_channel text) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  _secret_id uuid;
begin
  delete from public.messaging_channels where channel = _channel returning secret_id into _secret_id;
  if not found then
    return false;
  end if;
  if _secret_id is not null then
    delete from vault.secrets where id = _secret_id;
  end if;
  return true;
end $$;

-- ============================================================================
-- System secrets (job dispatch + unsubscribe signing), generated once, never leave the database
-- except to the service-role backend.
-- ============================================================================

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'prodbnb_jobs_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'prodbnb_jobs_secret',
      'Shared secret pg_cron sends to the backend job dispatcher'
    );
  end if;
  if not exists (select 1 from vault.secrets where name = 'prodbnb_unsubscribe_key') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'prodbnb_unsubscribe_key',
      'HMAC key for one-click email unsubscribe links'
    );
  end if;
end $$;

create function public.system_secret(_name text) returns text
language sql
security definer
set search_path = ''
stable
as $$
  select decrypted_secret from vault.decrypted_secrets
  where name = _name and _name in ('prodbnb_jobs_secret', 'prodbnb_unsubscribe_key');
$$;

-- ============================================================================
-- 5. Notification vocabulary (done before campaigns, which reference notifications)
-- ============================================================================

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (
  type in (
    'booking_request_received',
    'booking_confirmed',
    'booking_declined',
    'booking_cancelled',
    'payment_success',
    'payment_failed',
    'refund_processed',
    'new_message',
    'announcement'
  )
);

alter table public.notifications drop constraint notifications_entity_type_check;
alter table public.notifications add constraint notifications_entity_type_check check (
  entity_type in ('booking', 'conversation', 'announcement')
);

alter table public.notification_preferences drop constraint notification_preferences_category_check;
alter table public.notification_preferences add constraint notification_preferences_category_check check (
  category in ('booking', 'payment', 'message', 'announcement')
);

do $$
declare
  _name text;
begin
  for _name in
    select conname from pg_constraint
    where conrelid = 'public.notification_delivery_attempts'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%apns%'
  loop
    execute format('alter table public.notification_delivery_attempts drop constraint %I', _name);
  end loop;
end $$;

alter table public.notification_delivery_attempts add constraint notification_delivery_attempts_provider_check
  check (provider in ('disabled', 'apns', 'fcm', 'webpush'));

-- Device metadata. `web_push_keys` holds a Web Push subscription's public p256dh/auth keys (the
-- endpoint itself is device_token); app_version feeds the Platforms page's "versions in use".
alter table public.user_devices
  add column app_version text check (app_version is null or char_length(app_version) <= 32),
  add column web_push_keys jsonb;

-- ============================================================================
-- 2. Campaigns
-- ============================================================================

create table public.notification_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  kind text not null default 'announcement' check (kind in ('announcement', 'direct')),
  channels text[] not null
    check (cardinality(channels) > 0 and channels <@ array['in_app', 'push', 'email']::text[]),
  platforms text[] not null default array['ios', 'android', 'web']::text[]
    check (platforms <@ array['ios', 'android', 'web']::text[]),
  -- {"type":"all"} | {"type":"role","role":"host"} | {"type":"users","user_ids":[...]}
  -- | {"type":"platform_users"} (anyone with an active device on `platforms`)
  audience jsonb not null,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  link_url text check (link_url is null or (char_length(link_url) <= 500 and link_url ~ '^(https://|prodbnb://)')),
  email_subject text check (email_subject is null or char_length(email_subject) <= 200),
  email_body text check (email_body is null or char_length(email_body) <= 50000),
  status text not null default 'draft'
    check (status in ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed')),
  scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  recipient_count integer,
  last_error text,
  created_by uuid references public.profiles (id) on delete set null,
  sent_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ('email' <> all (channels) or (email_subject is not null and email_body is not null))
);

create index notification_campaigns_status_idx on public.notification_campaigns (status, scheduled_at);
create index notification_campaigns_created_at_idx on public.notification_campaigns (created_at desc);

create trigger set_notification_campaigns_updated_at
  before update on public.notification_campaigns
  for each row execute function public.set_updated_at();

create table public.campaign_recipients (
  campaign_id uuid not null references public.notification_campaigns (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  email text,
  in_app_status text not null default 'skipped' check (in_app_status in ('pending', 'created', 'skipped', 'failed')),
  push_status text not null default 'skipped'
    check (push_status in ('pending', 'sent', 'partial', 'failed', 'no_devices', 'opted_out', 'skipped')),
  email_status text not null default 'skipped'
    check (email_status in ('pending', 'sent', 'failed', 'no_email', 'unsubscribed', 'skipped')),
  notification_id uuid references public.notifications (id) on delete set null,
  push_sent integer not null default 0,
  push_failed integer not null default 0,
  error text check (error is null or char_length(error) <= 1000),
  claimed_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (campaign_id, user_id)
);

create index campaign_recipients_pending_idx on public.campaign_recipients (campaign_id) where processed_at is null;
create index campaign_recipients_user_idx on public.campaign_recipients (user_id);

create table public.email_suppressions (
  email text primary key check (email = lower(email)),
  reason text not null check (reason in ('unsubscribed', 'bounced', 'admin')),
  user_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.notification_campaigns enable row level security;
alter table public.campaign_recipients enable row level security;
alter table public.email_suppressions enable row level security;
revoke all on public.notification_campaigns, public.campaign_recipients, public.email_suppressions from anon, authenticated;
grant select, insert, update, delete on public.notification_campaigns, public.campaign_recipients, public.email_suppressions to service_role;

-- Expand a campaign's audience into recipient rows, once. Suspended and deleted accounts are
-- never included. Returns the number of recipients.
create function public.campaign_expand_recipients(_campaign_id uuid) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  _c public.notification_campaigns;
  _type text;
  _count integer;
  _wants_in_app boolean;
begin
  select * into _c from public.notification_campaigns where id = _campaign_id for update;
  if not found then
    raise exception 'campaign_not_found';
  end if;

  _type := _c.audience ->> 'type';
  -- Push needs the in-app row as its anchor (delivery attempts reference it), so either channel
  -- creates one.
  _wants_in_app := 'in_app' = any (_c.channels) or 'push' = any (_c.channels);

  insert into public.campaign_recipients (campaign_id, user_id, email, in_app_status, push_status, email_status)
  select
    _campaign_id,
    p.id,
    lower(u.email),
    case when _wants_in_app then 'pending' else 'skipped' end,
    case when 'push' = any (_c.channels) then 'pending' else 'skipped' end,
    case when 'email' = any (_c.channels) then 'pending' else 'skipped' end
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.status = 'active'
    and (
      _type = 'all'
      or (_type = 'role' and exists (
        select 1 from public.user_roles r where r.user_id = p.id and r.role = (_c.audience ->> 'role')
      ))
      or (_type = 'users' and p.id in (
        select value::uuid from jsonb_array_elements_text(coalesce(_c.audience -> 'user_ids', '[]'::jsonb))
      ))
      or (_type = 'platform_users' and exists (
        select 1 from public.user_devices d
        where d.user_id = p.id and d.is_active and d.platform = any (_c.platforms)
      ))
    )
  on conflict do nothing;

  get diagnostics _count = row_count;
  update public.notification_campaigns
  set recipient_count = (select count(*) from public.campaign_recipients where campaign_id = _campaign_id)
  where id = _campaign_id;
  return _count;
end $$;

-- Lease up to _limit unprocessed recipients. A lease that is 5 minutes old (a dispatcher that died
-- mid-batch) is taken over; `skip locked` keeps two concurrent dispatchers off the same rows.
create function public.campaign_claim_recipients(_campaign_id uuid, _limit integer)
returns setof public.campaign_recipients
language sql
security definer
set search_path = ''
as $$
  update public.campaign_recipients r
  set claimed_at = now()
  where (r.campaign_id, r.user_id) in (
    select c.campaign_id, c.user_id
    from public.campaign_recipients c
    where c.campaign_id = _campaign_id
      and c.processed_at is null
      and (c.claimed_at is null or c.claimed_at < now() - interval '5 minutes')
    order by c.created_at, c.user_id
    limit greatest(1, least(_limit, 500))
    for update skip locked
  )
  returning r.*;
$$;

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
  email_missing bigint
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
    count(*) filter (where r.email_status = 'no_email')
  from public.campaign_recipients r
  where r.campaign_id = any (_campaign_ids)
  group by r.campaign_id;
$$;

-- Audience size preview, before a campaign exists.
create function public.admin_audience_preview(_audience jsonb, _platforms text[])
returns table (users bigint, with_email bigint, ios_devices bigint, android_devices bigint, web_devices bigint)
language sql
security definer
set search_path = ''
stable
as $$
  with audience as (
    select p.id, u.email
    from public.profiles p
    join auth.users u on u.id = p.id
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
      )
  )
  select
    (select count(*) from audience),
    (select count(*) from audience a where a.email is not null
       and not exists (select 1 from public.email_suppressions s where s.email = lower(a.email))),
    (select count(*) from public.user_devices d join audience a on a.id = d.user_id where d.is_active and d.platform = 'ios'),
    (select count(*) from public.user_devices d join audience a on a.id = d.user_id where d.is_active and d.platform = 'android'),
    (select count(*) from public.user_devices d join audience a on a.id = d.user_id where d.is_active and d.platform = 'web');
$$;

-- ============================================================================
-- 4. Background job dispatch (pg_cron -> pg_net -> backend)
-- ============================================================================

create table public.background_jobs_config (
  id uuid primary key default gen_random_uuid(),
  singleton boolean not null default true unique check (singleton),
  dispatch_url text check (dispatch_url is null or dispatch_url ~ '^https?://'),
  enabled boolean not null default false,
  last_tick_at timestamptz,
  last_run_at timestamptz,
  last_run_ok boolean,
  last_run_summary jsonb,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.background_jobs_config (singleton) values (true);

create trigger set_background_jobs_config_updated_at
  before update on public.background_jobs_config
  for each row execute function public.set_updated_at();

alter table public.background_jobs_config enable row level security;
revoke all on public.background_jobs_config from anon, authenticated;
grant select, insert, update, delete on public.background_jobs_config to service_role;

create function public.dispatch_background_jobs() returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  _cfg public.background_jobs_config;
begin
  select * into _cfg from public.background_jobs_config where singleton;
  if not found or not _cfg.enabled or _cfg.dispatch_url is null then
    return false;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    return false;
  end if;
  if not exists (
    select 1 from public.notification_campaigns
    where status = 'sending' or (status = 'scheduled' and scheduled_at <= now())
  ) then
    return false;
  end if;

  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 60000)'
  using
    _cfg.dispatch_url,
    '{}'::jsonb,
    jsonb_build_object(
      'Content-Type', 'application/json',
      'X-ProdBnb-Job-Secret', public.system_secret('prodbnb_jobs_secret')
    );

  update public.background_jobs_config set last_tick_at = now() where id = _cfg.id;
  return true;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('prodbnb-dispatch-background-jobs', '* * * * *', 'select public.dispatch_background_jobs()');
  end if;
end $$;

-- ============================================================================
-- Function privileges: service_role only.
-- ============================================================================

revoke all on function public.messaging_channel_save(text, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.messaging_channel_secret(text) from public, anon, authenticated;
revoke all on function public.messaging_channel_remove(text) from public, anon, authenticated;
revoke all on function public.system_secret(text) from public, anon, authenticated;
revoke all on function public.campaign_expand_recipients(uuid) from public, anon, authenticated;
revoke all on function public.campaign_claim_recipients(uuid, integer) from public, anon, authenticated;
revoke all on function public.admin_campaign_stats(uuid[]) from public, anon, authenticated;
revoke all on function public.admin_audience_preview(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.dispatch_background_jobs() from public, anon, authenticated;

grant execute on function public.messaging_channel_save(text, jsonb, text, uuid) to service_role;
grant execute on function public.messaging_channel_secret(text) to service_role;
grant execute on function public.messaging_channel_remove(text) to service_role;
grant execute on function public.system_secret(text) to service_role;
grant execute on function public.campaign_expand_recipients(uuid) to service_role;
grant execute on function public.campaign_claim_recipients(uuid, integer) to service_role;
grant execute on function public.admin_campaign_stats(uuid[]) to service_role;
grant execute on function public.admin_audience_preview(jsonb, text[]) to service_role;
grant execute on function public.dispatch_background_jobs() to service_role;

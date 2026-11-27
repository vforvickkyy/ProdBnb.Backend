-- ============================================================================
-- SMS: sign-in codes and booking / payment / payout texts, through any SMS provider.
--
-- 1. sms_settings (one row): which provider is used and how -- off, test (nothing leaves, every text
--    is only logged) or live -- plus the DLT sender name (header) and entity id, which belong to the
--    company and stay the same whatever provider sends.
-- 2. sms_providers: one row per provider ever connected. Non-secret settings in `config`, the API
--    key / token in Supabase Vault. Switching provider = pick another connected row.
-- 3. sms_templates: the wording of every text, with named {placeholders}, and its DLT template id.
--    Edited in the admin; the DLT form of each is generated from it ({placeholder} -> {#var#}).
-- 4. sms_outbox: every text, queued -> sent -> delivered / failed, retried by the job dispatcher.
--    One row per event and person (idempotency_key). Sign-in codes are logged without the code.
-- 5. profiles.sms_updates: the person's own switch for optional texts (reminders, listing news).
--    Codes, booking and payment texts always go.
-- Service role only; the admin console and apps go through the API.
-- ============================================================================

-- 1. Settings --------------------------------------------------------------------------------------

create table public.sms_settings (
  singleton boolean primary key default true check (singleton),
  mode text not null default 'test' check (mode in ('off', 'test', 'live')),
  active_provider text check (active_provider is null or active_provider in ('msg91', 'twilio', 'twofactor', 'gupshup')),
  sender_id text check (sender_id is null or sender_id ~ '^[A-Z0-9]{3,11}$'),
  dlt_entity_id text check (dlt_entity_id is null or dlt_entity_id ~ '^[0-9]{6,30}$'),
  -- Only these numbers get real texts while mode = 'test' and a provider is connected (try it on
  -- your own phones before DLT is approved for everyone). Empty = nobody.
  test_numbers text[] not null default '{}' check (cardinality(test_numbers) <= 20),
  -- Sign-in codes per number per hour, on top of Supabase's own limit.
  otp_per_hour integer not null default 5 check (otp_per_hour between 1 and 30),
  -- Shared secret in the delivery-report address given to the provider.
  webhook_token text not null default encode(extensions.gen_random_bytes(18), 'hex'),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.sms_settings (singleton) values (true);

comment on table public.sms_settings is
  'SMS: mode (off / test / live), active provider and DLT sender details. One row. Backend only.';

create trigger sms_settings_set_updated_at before update on public.sms_settings
  for each row execute function public.set_updated_at();

alter table public.sms_settings enable row level security;
revoke all on public.sms_settings from anon, authenticated;
grant select, insert, update, delete on public.sms_settings to service_role;

-- 2. Providers -------------------------------------------------------------------------------------

create table public.sms_providers (
  provider text primary key check (provider in ('msg91', 'twilio', 'twofactor', 'gupshup')),
  config jsonb not null default '{}'::jsonb,
  secret_id uuid,
  last_tested_at timestamptz,
  last_test_ok boolean,
  last_test_error text check (last_test_error is null or char_length(last_test_error) <= 1000),
  connected_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.sms_providers is
  'Connected SMS providers. Keys are in Vault (secret_id); config is non-secret. Backend only.';

create trigger sms_providers_set_updated_at before update on public.sms_providers
  for each row execute function public.set_updated_at();

alter table public.sms_providers enable row level security;
revoke all on public.sms_providers from anon, authenticated;
grant select, insert, update, delete on public.sms_providers to service_role;

/** Save a provider's settings, and its key when given (null keeps the stored one). */
create function public.sms_provider_save(_provider text, _config jsonb, _secret text, _actor_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _row public.sms_providers;
  _secret_id uuid;
  _name text := 'prodbnb_sms_' || _provider;
begin
  if _provider not in ('msg91', 'twilio', 'twofactor', 'gupshup') then
    raise exception 'invalid_provider';
  end if;
  select * into _row from public.sms_providers where provider = _provider for update;
  _secret_id := _row.secret_id;
  if _secret is not null then
    if _secret_id is null then
      select id into _secret_id from vault.secrets where name = _name;
    end if;
    if _secret_id is null then
      _secret_id := vault.create_secret(_secret, _name, 'SMS provider credential');
    else
      perform vault.update_secret(_secret_id, _secret, _name, 'SMS provider credential');
    end if;
  end if;
  if _secret_id is null then
    raise exception 'secret_required';
  end if;
  insert into public.sms_providers (provider, config, secret_id, connected_by)
  values (_provider, coalesce(_config, '{}'::jsonb), _secret_id, _actor_id)
  on conflict (provider) do update
    set config = coalesce(excluded.config, public.sms_providers.config),
        secret_id = excluded.secret_id,
        connected_by = excluded.connected_by,
        last_tested_at = null,
        last_test_ok = null,
        last_test_error = null;
end $$;

create function public.sms_provider_secret(_provider text) returns text
language sql
security definer
set search_path = ''
stable
as $$
  select ds.decrypted_secret
  from public.sms_providers p
  join vault.decrypted_secrets ds on ds.id = p.secret_id
  where p.provider = _provider;
$$;

create function public.sms_provider_remove(_provider text) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  _secret_id uuid;
begin
  delete from public.sms_providers where provider = _provider returning secret_id into _secret_id;
  if not found then
    return false;
  end if;
  if _secret_id is not null then
    delete from vault.secrets where id = _secret_id;
  end if;
  update public.sms_settings set active_provider = null where active_provider = _provider;
  return true;
end $$;

revoke all on function public.sms_provider_save(text, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.sms_provider_secret(text) from public, anon, authenticated;
revoke all on function public.sms_provider_remove(text) from public, anon, authenticated;
grant execute on function public.sms_provider_save(text, jsonb, text, uuid) to service_role;
grant execute on function public.sms_provider_secret(text) to service_role;
grant execute on function public.sms_provider_remove(text) to service_role;

-- 3. Templates -------------------------------------------------------------------------------------

create table public.sms_templates (
  key text primary key check (key ~ '^[a-z0-9_]{2,60}$'),
  name text not null check (char_length(name) between 1 and 100),
  audience text not null check (audience in ('booker', 'host', 'everyone')),
  -- otp: sign-in codes. transactional: booking and payment texts (always sent). service: optional
  -- updates the person can switch off. DLT registers each template under one of these types.
  category text not null check (category in ('otp', 'transactional', 'service')),
  body text not null check (char_length(body) between 1 and 1000),
  dlt_template_id text check (dlt_template_id is null or dlt_template_id ~ '^[0-9]{6,30}$'),
  -- MSG91 and similar providers give each approved template their own id too (optional).
  provider_template_id text check (provider_template_id is null or char_length(provider_template_id) <= 100),
  enabled boolean not null default true,
  sort_order integer not null default 0,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);

comment on table public.sms_templates is
  'SMS wording with {placeholders} and DLT template ids. {brand} and {site} are fixed text in the '
  'DLT form; every other placeholder becomes {#var#}. Backend only.';

create trigger sms_templates_set_updated_at before update on public.sms_templates
  for each row execute function public.set_updated_at();

alter table public.sms_templates enable row level security;
revoke all on public.sms_templates from anon, authenticated;
grant select, insert, update, delete on public.sms_templates to service_role;

insert into public.sms_templates (key, name, audience, category, sort_order, body) values
  ('auth_otp', 'Sign-in and verification code', 'everyone', 'otp', 10,
   '{code} is your {brand} code. It expires in 10 minutes. Never share it with anyone, even {brand} staff.'),
  -- Booker
  ('quote_request_sent', 'Price request sent', 'booker', 'transactional', 20,
   'Hi {name}, your price request for {place} on {when} is with the host. We will text you when the price is ready. - {brand}'),
  ('quote_ready', 'Price ready to pay', 'booker', 'transactional', 30,
   'Hi {name}, the host sent a price of {amount} for {place} on {when}. Pay on {site} or the app to confirm booking {ref}. - {brand}'),
  ('booking_confirmed', 'Booking confirmed', 'booker', 'transactional', 40,
   'Booking {ref} confirmed: {place}, {when}. Address and host contact are in your bookings on {site} or the app. - {brand}'),
  ('booking_declined', 'Booking declined', 'booker', 'transactional', 50,
   'Hi {name}, your request {ref} for {place} on {when} was declined. Any payment is refunded in full. Find another place on {site}. - {brand}'),
  ('booking_cancelled', 'Booking cancelled (booker)', 'booker', 'transactional', 60,
   'Booking {ref} for {place} on {when} is cancelled. Refund details are in your bookings on {site}. - {brand}'),
  ('payment_success', 'Payment received', 'booker', 'transactional', 70,
   'Payment of {amount} received for booking {ref} at {place}. Your receipt is in your bookings on {site}. - {brand}'),
  ('payment_failed', 'Payment failed', 'booker', 'transactional', 80,
   'Your payment for booking {ref} at {place} did not go through. No money was taken. Try again on {site} or the app. - {brand}'),
  ('refund_processed', 'Refund sent', 'booker', 'transactional', 90,
   'Refund of {amount} for booking {ref} is on its way. It reaches your account in 5-7 working days. - {brand}'),
  ('booking_reminder', 'Reminder the day before (booker)', 'booker', 'service', 100,
   'Reminder: your shoot at {place} is {when}. Address and host contact: your bookings on {site}. - {brand}'),
  -- Host
  ('host_booking_request', 'New booking request', 'host', 'transactional', 110,
   'New request {ref} for {place}: {when}, crew of {crew}. Accept or decline on {site} or the app. - {brand}'),
  ('host_quote_request', 'New price request', 'host', 'transactional', 120,
   'New price request {ref} for {place}: {when}, crew of {crew}. Send a price or decline on {site} or the app. - {brand}'),
  ('host_booking_confirmed', 'New instant booking', 'host', 'transactional', 130,
   'New booking {ref} for {place}: {when}, by {booker}. It is confirmed. Details on {site} or the app. - {brand}'),
  ('host_booking_cancelled', 'Booking cancelled (host)', 'host', 'transactional', 140,
   'Booking {ref} for {place} on {when} is cancelled. Those dates are open again. - {brand}'),
  ('host_booking_reminder', 'Reminder the day before (host)', 'host', 'service', 150,
   'Reminder: {booker} shoots at {place} {when}, crew of {crew}. Details on {site} or the app. - {brand}'),
  ('payout_sent', 'Payout sent', 'host', 'transactional', 160,
   'Payout of {amount} sent to your bank account ending {account}. It usually arrives within 1-2 working days. - {brand}'),
  ('listing_approved', 'Listing approved', 'host', 'service', 170,
   'Good news {name}: {place} is approved and live on {brand}. Bookers can find it now on {site}. - {brand}'),
  ('listing_rejected', 'Listing needs changes', 'host', 'service', 180,
   'Hi {name}, {place} needs a few changes before it can go live. See what to fix in your listings on {site}. - {brand}');

-- 4. Outbox ----------------------------------------------------------------------------------------

create table public.sms_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id) on delete set null,
  to_phone text not null check (char_length(to_phone) between 3 and 20),
  template text not null check (char_length(template) between 1 and 60),
  idempotency_key text not null unique check (char_length(idempotency_key) <= 200),
  data jsonb not null default '{}'::jsonb,
  -- The text as sent (sign-in codes: with the code masked).
  body text check (body is null or char_length(body) <= 1000),
  segments integer,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'delivered', 'failed', 'skipped')),
  -- 'test' = logged only, nothing left the building.
  mode text not null default 'live' check (mode in ('test', 'live')),
  provider text,
  provider_message_id text,
  attempts integer not null default 0,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  send_after timestamptz not null default now(),
  locked_until timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.sms_outbox is
  'Every SMS: queued, sent (with retries), delivered, logged. Written and read by the backend only.';

create index sms_outbox_due_idx on public.sms_outbox (send_after) where status = 'queued';
create index sms_outbox_user_idx on public.sms_outbox (user_id, created_at desc);
create index sms_outbox_created_idx on public.sms_outbox (created_at desc);
create index sms_outbox_phone_idx on public.sms_outbox (to_phone, template, created_at desc);
create index sms_outbox_provider_message_idx on public.sms_outbox (provider_message_id) where provider_message_id is not null;

alter table public.sms_outbox enable row level security;
revoke all on table public.sms_outbox from anon, authenticated;
grant select, insert, update, delete on public.sms_outbox to service_role;

create trigger sms_outbox_set_updated_at before update on public.sms_outbox
  for each row execute function public.set_updated_at();

-- 5. The person's switch ---------------------------------------------------------------------------

alter table public.profiles add column sms_updates boolean not null default true;

comment on column public.profiles.sms_updates is
  'Optional texts (day-before reminders, listing news). Sign-in codes, booking and payment texts '
  'always go. Changed through /v1/me/sms-preferences.';

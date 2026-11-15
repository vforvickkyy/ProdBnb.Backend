-- Website (Console 3): settings and integrations for the public website, managed from the admin.
--
--  * site_integrations -- one row per provider the website depends on:
--      google_maps  config: browser_key (public by design: it is sent to every browser and must be
--                   locked to the site's domains with HTTP-referrer restrictions in Google Cloud),
--                   map_id; secret (Vault): an optional server key for backend geocoding.
--      vercel       config: project_id, team_id of the website's Vercel project; secret (Vault): an
--                   access token, used only by the backend to manage the website's domains.
--    Secrets follow the messaging-channel pattern exactly: written through site_integration_save,
--    read only through site_integration_secret, both service-role-only; never returned to a client.
--  * site_settings -- one row: the website's primary domain (canonical URLs, sitemaps, emails).
--  * platform_settings.availability_requires_login -- availability is shown to signed-in people only.
--    Defaults to on; an admin can turn it off (e.g. until an app update that handles it ships).
--  * admin_audit_log -- widened (every existing value re-listed) for the new actions.

create table public.site_integrations (
  id uuid primary key default gen_random_uuid(),
  provider text not null unique check (provider in ('google_maps', 'vercel')),
  config jsonb not null default '{}'::jsonb,
  secret_id uuid,
  enabled boolean not null default true,
  last_tested_at timestamptz,
  last_test_ok boolean,
  last_test_error text,
  connected_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.site_integrations is
  'Website integrations (Google Maps, Vercel). Service role only; secrets live in Vault via site_integration_save.';

alter table public.site_integrations enable row level security;
-- No policies: only the backend (service role) reads or writes this table.

create table public.site_settings (
  id uuid primary key default gen_random_uuid(),
  singleton boolean not null default true unique check (singleton),
  primary_domain text check (primary_domain is null or primary_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.site_settings is
  'Single-row website configuration. primary_domain drives canonical URLs and sitemaps.';

alter table public.site_settings enable row level security;
insert into public.site_settings (singleton) values (true);

alter table public.platform_settings
  add column availability_requires_login boolean not null default true;

comment on column public.platform_settings.availability_requires_login is
  'When true, GET /v1/locations/:id/availability answers signed-in callers only (401 AUTH_REQUIRED otherwise).';

create trigger site_integrations_set_updated_at before update on public.site_integrations
  for each row execute function public.set_updated_at();
create trigger site_settings_set_updated_at before update on public.site_settings
  for each row execute function public.set_updated_at();

create function public.site_integration_save(
  _provider text,
  _config jsonb,
  _secret text,
  _actor_id uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  _row public.site_integrations;
  _secret_id uuid;
  _name text := 'site_integration_' || _provider;
begin
  if _provider not in ('google_maps', 'vercel') then
    raise exception 'invalid_provider';
  end if;

  select * into _row from public.site_integrations where provider = _provider for update;
  _secret_id := _row.secret_id;

  if _secret is not null then
    if _secret_id is null then
      select id into _secret_id from vault.secrets where name = _name;
    end if;
    if _secret_id is null then
      _secret_id := vault.create_secret(_secret, _name, 'Website integration credential');
    else
      perform vault.update_secret(_secret_id, _secret, _name, 'Website integration credential');
    end if;
  end if;

  if _row.id is null then
    insert into public.site_integrations (provider, config, secret_id, connected_by)
    values (_provider, coalesce(_config, '{}'::jsonb), _secret_id, _actor_id)
    returning * into _row;
  else
    update public.site_integrations
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

create function public.site_integration_secret(_provider text) returns text
language sql
security definer
set search_path = ''
stable
as $$
  select ds.decrypted_secret
  from public.site_integrations si
  join vault.decrypted_secrets ds on ds.id = si.secret_id
  where si.provider = _provider;
$$;

create function public.site_integration_remove(_provider text) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  _secret_id uuid;
begin
  delete from public.site_integrations where provider = _provider returning secret_id into _secret_id;
  if not found then
    return false;
  end if;
  if _secret_id is not null then
    delete from vault.secrets where id = _secret_id;
  end if;
  return true;
end $$;

revoke all on function public.site_integration_save(text, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.site_integration_secret(text) from public, anon, authenticated;
revoke all on function public.site_integration_remove(text) from public, anon, authenticated;
grant execute on function public.site_integration_save(text, jsonb, text, uuid) to service_role;
grant execute on function public.site_integration_secret(text) to service_role;
grant execute on function public.site_integration_remove(text) to service_role;

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
    'ADMIN_SET_PRIMARY_DOMAIN'
  )
);

alter table public.admin_audit_log add constraint admin_audit_log_target_type_check check (
  target_type in (
    'location', 'user', 'booking', 'payment', 'media', 'section', 'catalog_item', 'settings',
    'collection', 'campaign', 'channel', 'platform', 'feature_flag', 'incident', 'release',
    'site_integration', 'site'
  )
);

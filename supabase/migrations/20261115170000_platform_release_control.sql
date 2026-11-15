-- Admin Console 2: platform release control -- what is live where, which features, issues, and
-- what ships next. Everything here is read by the apps through ONE public endpoint,
-- GET /v1/app-config (served by the backend from these tables), and written only by the Admin API.
--
--   app_platforms              ios / android / web: launch status, live / latest / minimum version,
--                              update prompts, maintenance mode
--   feature_flags              one row per feature, per-platform on/off + optional minimum version
--   platform_incidents (+ _updates)   known issues and their timeline
--   release_plans              planned / in-progress / shipped releases per platform
--   client_version_activity    which app versions are actually in use (one row per user per
--                              version per day, pruned after 90 days)

create table public.app_platforms (
  id uuid primary key default gen_random_uuid(),
  platform text not null unique check (platform in ('ios', 'android', 'web')),
  display_name text not null,
  status text not null default 'not_launched'
    check (status in ('not_launched', 'in_development', 'beta', 'live', 'maintenance', 'deprecated')),
  live_version text check (live_version is null or live_version ~ '^\d+(\.\d+){0,3}$'),
  latest_version text check (latest_version is null or latest_version ~ '^\d+(\.\d+){0,3}$'),
  min_supported_version text check (min_supported_version is null or min_supported_version ~ '^\d+(\.\d+){0,3}$'),
  store_url text check (store_url is null or store_url ~ '^https://'),
  update_message text check (update_message is null or char_length(update_message) <= 300),
  force_update_message text check (force_update_message is null or char_length(force_update_message) <= 300),
  maintenance_mode boolean not null default false,
  maintenance_message text check (maintenance_message is null or char_length(maintenance_message) <= 300),
  notes text check (notes is null or char_length(notes) <= 5000),
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.app_platforms (platform, display_name, status) values
  ('ios', 'iOS app', 'in_development'),
  ('android', 'Android app', 'not_launched'),
  ('web', 'Web app', 'not_launched');

create trigger set_app_platforms_updated_at
  before update on public.app_platforms
  for each row execute function public.set_updated_at();

create table public.feature_flags (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  -- {"ios": {"enabled": true, "min_version": "1.2.0"}, "android": {...}, "web": {...}}
  targets jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_feature_flags_updated_at
  before update on public.feature_flags
  for each row execute function public.set_updated_at();

create table public.platform_incidents (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 160),
  -- Shown to users by /v1/app-config while the incident is open and is_public.
  summary text not null default '' check (char_length(summary) <= 1000),
  severity text not null default 'minor' check (severity in ('minor', 'major', 'critical')),
  status text not null default 'investigating'
    check (status in ('investigating', 'identified', 'monitoring', 'resolved')),
  platforms text[] not null
    check (cardinality(platforms) > 0 and platforms <@ array['ios', 'android', 'web', 'backend', 'admin']::text[]),
  is_public boolean not null default false,
  started_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index platform_incidents_open_idx on public.platform_incidents (status, started_at desc);

create trigger set_platform_incidents_updated_at
  before update on public.platform_incidents
  for each row execute function public.set_updated_at();

create table public.platform_incident_updates (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.platform_incidents (id) on delete cascade,
  status text not null check (status in ('investigating', 'identified', 'monitoring', 'resolved')),
  message text not null check (char_length(btrim(message)) between 1 and 2000),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index platform_incident_updates_incident_idx on public.platform_incident_updates (incident_id, created_at);

create table public.release_plans (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('ios', 'android', 'web', 'backend', 'admin')),
  version text not null check (char_length(btrim(version)) between 1 and 32),
  title text not null check (char_length(btrim(title)) between 1 and 160),
  notes text not null default '' check (char_length(notes) <= 10000),
  status text not null default 'planned'
    check (status in ('planned', 'in_progress', 'in_review', 'released', 'cancelled')),
  target_date date,
  released_at timestamptz,
  feature_keys text[] not null default '{}'::text[],
  created_by uuid references public.profiles (id) on delete set null,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index release_plans_platform_idx on public.release_plans (platform, status, target_date);

create trigger set_release_plans_updated_at
  before update on public.release_plans
  for each row execute function public.set_updated_at();

create table public.client_version_activity (
  day date not null,
  platform text not null check (platform in ('ios', 'android', 'web')),
  app_version text not null check (char_length(app_version) between 1 and 32),
  user_id uuid not null references public.profiles (id) on delete cascade,
  primary key (day, platform, app_version, user_id)
);

create index client_version_activity_day_idx on public.client_version_activity (day);

-- Versions in use over the last _days days: distinct users per (platform, version), plus active
-- push-registered devices reporting that version.
create function public.admin_client_versions(_days integer default 30)
returns table (platform text, app_version text, users bigint, devices bigint, last_seen date)
language sql
security definer
set search_path = ''
stable
as $$
  with activity as (
    select a.platform, a.app_version, count(distinct a.user_id) as users, max(a.day) as last_seen
    from public.client_version_activity a
    where a.day >= (current_date - greatest(1, least(_days, 365)))
    group by a.platform, a.app_version
  ),
  devices as (
    select d.platform, d.app_version, count(*) as devices, max(d.last_seen_at)::date as last_seen
    from public.user_devices d
    where d.is_active and d.app_version is not null
    group by d.platform, d.app_version
  )
  select
    coalesce(a.platform, d.platform),
    coalesce(a.app_version, d.app_version),
    coalesce(a.users, 0),
    coalesce(d.devices, 0),
    greatest(a.last_seen, d.last_seen)
  from activity a
  full outer join devices d on d.platform = a.platform and d.app_version = a.app_version
  order by 1, 5 desc nulls last;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'prodbnb-prune-client-version-activity',
      '17 3 * * *',
      $cron$delete from public.client_version_activity where day < current_date - 90$cron$
    );
  end if;
end $$;

alter table public.app_platforms enable row level security;
alter table public.feature_flags enable row level security;
alter table public.platform_incidents enable row level security;
alter table public.platform_incident_updates enable row level security;
alter table public.release_plans enable row level security;
alter table public.client_version_activity enable row level security;

revoke all on public.app_platforms, public.feature_flags, public.platform_incidents,
  public.platform_incident_updates, public.release_plans, public.client_version_activity
  from anon, authenticated;
grant select, insert, update, delete on public.app_platforms, public.feature_flags, public.platform_incidents,
  public.platform_incident_updates, public.release_plans, public.client_version_activity
  to service_role;

revoke all on function public.admin_client_versions(integer) from public, anon, authenticated;
grant execute on function public.admin_client_versions(integer) to service_role;

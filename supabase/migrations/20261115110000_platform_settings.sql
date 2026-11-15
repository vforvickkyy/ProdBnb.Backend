-- Admin Console 4: platform settings -- platform fee, tax and the unpaid-hold window.
--
-- One row, ever (`singleton`). Every default is the platform's current behaviour, so applying this
-- migration changes nothing until an admin edits a value:
--
--   platform_fee_bps     0     -> no platform fee (bookings.platform_fee_minor_units stays 0)
--   tax_bps              0     -> no tax          (bookings.tax_minor_units stays 0)
--   unpaid_hold_minutes  null  -> unpaid bookings never expire (today's behaviour)
--
-- Rates are basis points (1 bp = 0.01%), integers like every other money-shaped column here -- no
-- floating point anywhere near a price. Applied by src/modules/bookings/pricing.ts at booking
-- creation only; an existing booking's snapshot never changes (Phase 6 price-snapshot rule).
--
--   fee   = round(base * platform_fee_bps / 10000)
--   tax   = round((base + fee) * tax_bps / 10000)
--   total = base + fee + tax            (bookings_total_check already enforces this identity)
--
-- No client access at all: the backend reads it with the service-role client, and only the
-- /v1/admin/settings API (super_admin) writes it.

create table public.platform_settings (
  id uuid primary key default gen_random_uuid(),
  singleton boolean not null default true unique check (singleton),
  platform_fee_bps integer not null default 0 check (platform_fee_bps between 0 and 5000),
  tax_bps integer not null default 0 check (tax_bps between 0 and 5000),
  unpaid_hold_minutes integer check (unpaid_hold_minutes between 5 and 10080),
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.platform_settings is
  'Single-row platform configuration (fee, tax, unpaid-hold window). Defaults reproduce the '
  'pre-Admin-Console behaviour exactly. Written only via /v1/admin/settings (super_admin).';

insert into public.platform_settings (singleton) values (true);

create trigger set_platform_settings_updated_at
  before update on public.platform_settings
  for each row execute function public.set_updated_at();

alter table public.platform_settings enable row level security;

revoke all on public.platform_settings from anon, authenticated;
grant select, insert, update, delete on public.platform_settings to service_role;

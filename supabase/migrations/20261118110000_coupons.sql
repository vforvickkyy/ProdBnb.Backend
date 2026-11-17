-- Offers and coupons.
--
-- A coupon is created by ProdBnb (owner_type 'platform') or by a host for their own listings
-- ('host'). The discount comes off the listing price; the service fee and tax are then worked out on
-- the lower price. Who pays for it follows who created it: a platform coupon leaves the host's
-- earning at the full listing price (ProdBnb absorbs it); a host coupon comes out of that host's
-- earning. Each booking records the coupon, the discount and who funded it, at the moment it was
-- made, so later edits to a coupon never change a booking.

create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{2,29}$'),
  owner_type text not null check (owner_type in ('platform', 'host')),
  host_id uuid references public.profiles (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text check (description is null or char_length(description) <= 500),
  discount_type text not null check (discount_type in ('percent', 'fixed')),
  percent_off integer check (percent_off is null or percent_off between 1 and 100),
  amount_off_minor_units integer check (amount_off_minor_units is null or amount_off_minor_units > 0),
  max_discount_minor_units integer check (max_discount_minor_units is null or max_discount_minor_units > 0),
  min_booking_minor_units integer check (min_booking_minor_units is null or min_booking_minor_units > 0),
  booking_types text[] check (booking_types is null or booking_types <@ array['hourly', 'half_day', 'day', 'multi_day']::text[]),
  starts_at timestamptz,
  ends_at timestamptz,
  usage_limit integer check (usage_limit is null or usage_limit > 0),
  per_user_limit integer check (per_user_limit is null or per_user_limit > 0),
  first_booking_only boolean not null default false,
  -- Shown on listings and the Offers page; otherwise it works only for people given the code.
  is_public boolean not null default false,
  is_active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((owner_type = 'host') = (host_id is not null)),
  check (
    (discount_type = 'percent' and percent_off is not null and amount_off_minor_units is null)
    or (discount_type = 'fixed' and amount_off_minor_units is not null and percent_off is null and max_discount_minor_units is null)
  ),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create unique index coupons_code_unique on public.coupons (code);
create index coupons_host_idx on public.coupons (host_id) where host_id is not null;
create index coupons_public_active_idx on public.coupons (is_public, is_active);

comment on table public.coupons is 'Discount codes by ProdBnb or a host. Writes through the backend only.';

-- Empty = every listing (a host coupon: every listing of that host).
create table public.coupon_locations (
  coupon_id uuid not null references public.coupons (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  primary key (coupon_id, location_id)
);
create index coupon_locations_location_idx on public.coupon_locations (location_id);

-- One row per booking that used a coupon.
create table public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons (id) on delete restrict,
  booking_id uuid not null unique references public.bookings (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  discount_minor_units integer not null check (discount_minor_units >= 0),
  funded_by text not null check (funded_by in ('platform', 'host')),
  created_at timestamptz not null default now()
);
create index coupon_redemptions_coupon_idx on public.coupon_redemptions (coupon_id, created_at desc);
create index coupon_redemptions_user_idx on public.coupon_redemptions (user_id);

alter table public.bookings
  add column coupon_id uuid references public.coupons (id) on delete set null,
  add column discount_funded_by text check (discount_funded_by is null or discount_funded_by in ('platform', 'host'));

alter table public.coupons enable row level security;
alter table public.coupon_locations enable row level security;
alter table public.coupon_redemptions enable row level security;

create trigger coupons_set_updated_at before update on public.coupons
  for each row execute function public.set_updated_at();

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
    'ADMIN_DELETED_COUPON'
  )
);

alter table public.admin_audit_log add constraint admin_audit_log_target_type_check check (
  target_type in (
    'location', 'user', 'booking', 'payment', 'media', 'section', 'catalog_item', 'settings',
    'collection', 'campaign', 'channel', 'platform', 'feature_flag', 'incident', 'release',
    'site_integration', 'site', 'site_page', 'seo', 'refund_request', 'deletion_request',
    'payout_account', 'payout',
    'coupon'
  )
);

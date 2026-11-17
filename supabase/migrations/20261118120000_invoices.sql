-- Invoices and receipts.
--
-- One tax invoice per paid booking, from the company (ProdBnb) to the booker, for the full amount:
-- listing price, any offer, service fee, tax and total. Issued the moment the payment succeeds,
-- numbered per Indian financial year (PREFIX/26-27/0001, at most 16 characters as GST requires),
-- and emailed as a PDF when the template is complete and email is connected -- otherwise it waits
-- under "Pending to send" for the team. Every send (automatic or by a person) is logged.
--
-- The company details and the booker's billing details are copied onto the invoice when it is
-- issued, so editing the template or a profile later never changes an invoice already issued.

create table public.invoice_settings (
  id uuid primary key default gen_random_uuid(),
  singleton boolean not null default true unique check (singleton),
  legal_name text check (legal_name is null or char_length(btrim(legal_name)) between 1 and 200),
  trade_name text check (trade_name is null or char_length(btrim(trade_name)) between 1 and 200),
  gstin text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  pan text check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  address_line1 text check (address_line1 is null or char_length(address_line1) <= 200),
  address_line2 text check (address_line2 is null or char_length(address_line2) <= 200),
  city text check (city is null or char_length(city) <= 120),
  state text check (state is null or char_length(state) <= 120),
  state_code text check (state_code is null or state_code ~ '^[0-9]{2}$'),
  postal_code text check (postal_code is null or char_length(postal_code) <= 20),
  country text not null default 'India' check (char_length(country) <= 120),
  email text check (email is null or char_length(email) <= 200),
  phone text check (phone is null or char_length(phone) <= 40),
  website text check (website is null or char_length(website) <= 200),
  number_prefix text not null default 'INV' check (number_prefix ~ '^[A-Z0-9]{1,4}$'),
  sac_code text check (sac_code is null or sac_code ~ '^[0-9]{4,8}$'),
  tax_label text not null default 'GST' check (char_length(tax_label) between 1 and 40),
  notes text check (notes is null or char_length(notes) <= 1000),
  terms text check (terms is null or char_length(terms) <= 2000),
  signatory text check (signatory is null or char_length(signatory) <= 120),
  auto_send boolean not null default true,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.invoice_settings (singleton) values (true);

create table public.invoice_counters (
  fy text primary key check (fy ~ '^[0-9]{2}-[0-9]{2}$'),
  last_number integer not null default 0
);

/** The next number in a financial year's series, atomically. */
create function public.next_invoice_number(_fy text) returns integer
language sql
security definer
set search_path = ''
as $$
  insert into public.invoice_counters (fy, last_number) values (_fy, 1)
  on conflict (fy) do update set last_number = public.invoice_counters.last_number + 1
  returning last_number;
$$;
revoke all on function public.next_invoice_number(text) from public, anon, authenticated;
grant execute on function public.next_invoice_number(text) to service_role;

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  number text not null unique check (char_length(number) <= 16),
  fy text not null,
  sequence integer not null,
  booking_id uuid not null unique references public.bookings (id),
  payment_id uuid references public.payments (id),
  user_id uuid references public.profiles (id) on delete set null,
  issued_at timestamptz not null default now(),
  seller jsonb not null,
  billed_to jsonb not null,
  details jsonb not null,
  currency text not null default 'INR',
  subtotal_minor_units integer not null,
  discount_minor_units integer not null default 0,
  coupon_code text,
  service_fee_minor_units integer not null default 0,
  tax_minor_units integer not null default 0,
  tax_rate_bps integer,
  total_minor_units integer not null,
  tax_label text not null default 'GST',
  sac_code text,
  delivery_status text not null default 'pending' check (delivery_status in ('pending', 'sent', 'failed')),
  sent_via text check (sent_via is null or sent_via in ('auto', 'manual')),
  sent_at timestamptz,
  sent_to text,
  send_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index invoices_status_idx on public.invoices (delivery_status, issued_at desc);
create index invoices_user_idx on public.invoices (user_id, issued_at desc);

create table public.invoice_events (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references public.invoices (id) on delete cascade,
  payment_id uuid references public.payments (id) on delete cascade,
  kind text not null check (kind in ('issued', 'sent_auto', 'sent_manual', 'failed', 'receipt_sent')),
  to_email text,
  actor_id uuid references public.profiles (id) on delete set null,
  error text,
  created_at timestamptz not null default now(),
  check (invoice_id is not null or payment_id is not null)
);
create index invoice_events_invoice_idx on public.invoice_events (invoice_id, created_at desc);
create index invoice_events_payment_idx on public.invoice_events (payment_id, created_at desc);

comment on table public.invoices is 'One tax invoice per paid booking. Service role only; the API serves bookers their own.';

alter table public.invoice_settings enable row level security;
alter table public.invoice_counters enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_events enable row level security;

create trigger invoices_set_updated_at before update on public.invoices
  for each row execute function public.set_updated_at();
create trigger invoice_settings_set_updated_at before update on public.invoice_settings
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
    'ADMIN_DELETED_COUPON',
    -- Invoices and receipts
    'ADMIN_UPDATED_INVOICE_SETTINGS',
    'ADMIN_ISSUED_INVOICES',
    'ADMIN_SENT_INVOICE',
    'ADMIN_SENT_RECEIPT'
  )
);

alter table public.admin_audit_log add constraint admin_audit_log_target_type_check check (
  target_type in (
    'location', 'user', 'booking', 'payment', 'media', 'section', 'catalog_item', 'settings',
    'collection', 'campaign', 'channel', 'platform', 'feature_flag', 'incident', 'release',
    'site_integration', 'site', 'site_page', 'seo', 'refund_request', 'deletion_request',
    'payout_account', 'payout',
    'coupon',
    'invoice'
  )
);

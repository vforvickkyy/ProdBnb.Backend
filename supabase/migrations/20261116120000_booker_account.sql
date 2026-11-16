-- Booker account (website): refund requests, account deletion requests, payment method family.
--
--  * payments.method: the coarse method family a payment settled with ("upi", "credit_card",
--    "net_banking"...), for receipts and the account's payment history. Never instrument detail
--    (card digits, UPI handle, bank): the provider boundary already drops those on purpose.
--  * refund_requests: refunds stay a human decision (admin approves or declines). A request opens
--    automatically when a booking with a settled payment is cancelled or declined, or when the
--    booker asks ("something went wrong"). One open request per payment.
--  * account_deletion_requests: a user asks; an admin completes it by anonymising the profile and
--    locking sign-in. Bookings and payments are kept (tax and dispute records). One open request
--    per user.
--  * notifications: 'booking_updated' (already understood by the iOS app) for refund-request news.
--  * admin_audit_log: widened for the decisions above.

-- Payment method family ------------------------------------------------------------------------

alter table public.payments
  add column method text check (method is null or method ~ '^[a-z_]{1,40}$');

comment on column public.payments.method is
  'Coarse payment method family the payment settled with (upi, credit_card, debit_card, net_banking, wallet...). Never instrument detail.';

-- Refund requests -------------------------------------------------------------------------------

create table public.refund_requests (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id),
  payment_id uuid not null references public.payments (id),
  -- Null when the system opened it (a cancellation or decline of a paid booking).
  requested_by uuid references public.profiles (id) on delete set null,
  source text not null check (source in ('booker', 'cancellation', 'rejection')),
  reason text check (reason is null or char_length(reason) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'withdrawn')),
  approved_amount_minor_units integer check (approved_amount_minor_units is null or approved_amount_minor_units > 0),
  refund_id uuid references public.payment_refunds (id),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'approved') = (refund_id is not null))
);

comment on table public.refund_requests is
  'A booker''s request for money back, decided by the admin team. Writes go through the backend (service role); bookers can read their own.';

create unique index refund_requests_one_open_per_payment on public.refund_requests (payment_id) where status = 'pending';
create index refund_requests_status_created_idx on public.refund_requests (status, created_at desc);
create index refund_requests_booking_idx on public.refund_requests (booking_id);

alter table public.refund_requests enable row level security;

create policy refund_requests_select_own on public.refund_requests
  for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = refund_requests.booking_id and b.booker_id = (select auth.uid())));

create trigger refund_requests_set_updated_at before update on public.refund_requests
  for each row execute function public.set_updated_at();

-- Account deletion requests ---------------------------------------------------------------------

create table public.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  reason text check (reason is null or char_length(reason) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'completed', 'declined', 'withdrawn')),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.account_deletion_requests is
  'A user''s request to delete their account, completed or declined by the admin team. Writes through the backend only.';

create unique index account_deletion_requests_one_open_per_user on public.account_deletion_requests (user_id) where status = 'pending';
create index account_deletion_requests_status_created_idx on public.account_deletion_requests (status, created_at desc);

alter table public.account_deletion_requests enable row level security;

create policy account_deletion_requests_select_own on public.account_deletion_requests
  for select to authenticated
  using (user_id = (select auth.uid()));

create trigger account_deletion_requests_set_updated_at before update on public.account_deletion_requests
  for each row execute function public.set_updated_at();

-- Notification vocabulary -----------------------------------------------------------------------

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (
  type in (
    'booking_request_received',
    'booking_confirmed',
    'booking_declined',
    'booking_cancelled',
    'booking_updated',
    'payment_success',
    'payment_failed',
    'refund_processed',
    'new_message',
    'announcement'
  )
);

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
    'ADMIN_DECLINED_ACCOUNT_DELETION'
  )
);

alter table public.admin_audit_log add constraint admin_audit_log_target_type_check check (
  target_type in (
    'location', 'user', 'booking', 'payment', 'media', 'section', 'catalog_item', 'settings',
    'collection', 'campaign', 'channel', 'platform', 'feature_flag', 'incident', 'release',
    'site_integration', 'site', 'site_page', 'seo', 'refund_request', 'deletion_request'
  )
);

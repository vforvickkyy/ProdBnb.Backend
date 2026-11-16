-- Host payouts (website host area).
--
-- Bookers pay the platform; hosts are paid by the team, by bank transfer, recorded here.
--
--  * host_payout_accounts: where a host wants to be paid. The account number and PAN are secrets
--    kept in Supabase Vault (only their last four characters are stored in the table); IFSC and
--    the holder's name are plain. Service role only; the API returns masked values to the host and
--    reveals the full details to an admin only through an audited call.
--  * host_payouts / host_payout_items: a payout the team has sent, and exactly which bookings it
--    covered. A booking can be in one payout at most (unique booking_id), so nothing is paid twice.
--  * admin_audit_log: widened for viewing payout details and recording payouts.
--
-- What a host earns per booking (the listing price, reduced in proportion to any refund) and when
-- it becomes payable is computed by the backend from bookings, payments and refunds -- see
-- src/modules/payouts/earnings.service.ts.

-- Payout accounts ------------------------------------------------------------------------------

create table public.host_payout_accounts (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  account_holder_name text not null check (char_length(btrim(account_holder_name)) between 2 and 120),
  account_number_secret_id uuid,
  account_last4 text not null check (account_last4 ~ '^[0-9]{4}$'),
  ifsc text not null check (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_name text check (bank_name is null or char_length(bank_name) between 1 and 120),
  pan_secret_id uuid,
  pan_last4 text not null check (pan_last4 ~ '^[0-9]{4}[A-Z]$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.host_payout_accounts is
  'Where a host is paid. Account number and PAN live in Vault; service role only.';

alter table public.host_payout_accounts enable row level security;
create trigger host_payout_accounts_set_updated_at before update on public.host_payout_accounts
  for each row execute function public.set_updated_at();

/** Save (insert or replace) a host's payout account; the secrets go to Vault. */
create function public.host_payout_account_save(
  _user_id uuid,
  _holder text,
  _account_number text,
  _ifsc text,
  _bank_name text,
  _pan text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _row public.host_payout_accounts;
  _account_secret uuid;
  _pan_secret uuid;
begin
  if _account_number !~ '^[0-9]{9,18}$' then raise exception 'invalid_account_number'; end if;
  if _pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then raise exception 'invalid_pan'; end if;

  select * into _row from public.host_payout_accounts where user_id = _user_id for update;
  _account_secret := _row.account_number_secret_id;
  _pan_secret := _row.pan_secret_id;

  if _account_secret is null then
    _account_secret := vault.create_secret(_account_number, 'payout_account_' || _user_id, 'Host payout bank account number');
  else
    perform vault.update_secret(_account_secret, _account_number, 'payout_account_' || _user_id, 'Host payout bank account number');
  end if;
  if _pan_secret is null then
    _pan_secret := vault.create_secret(_pan, 'payout_pan_' || _user_id, 'Host PAN');
  else
    perform vault.update_secret(_pan_secret, _pan, 'payout_pan_' || _user_id, 'Host PAN');
  end if;

  insert into public.host_payout_accounts
    (user_id, account_holder_name, account_number_secret_id, account_last4, ifsc, bank_name, pan_secret_id, pan_last4)
  values
    (_user_id, btrim(_holder), _account_secret, right(_account_number, 4), _ifsc, nullif(btrim(coalesce(_bank_name, '')), ''), _pan_secret, right(_pan, 5))
  on conflict (user_id) do update set
    account_holder_name = excluded.account_holder_name,
    account_number_secret_id = excluded.account_number_secret_id,
    account_last4 = excluded.account_last4,
    ifsc = excluded.ifsc,
    bank_name = excluded.bank_name,
    pan_secret_id = excluded.pan_secret_id,
    pan_last4 = excluded.pan_last4;
end $$;

/** The full account number and PAN, for an admin sending a payout. Called only by audited code. */
create function public.host_payout_account_reveal(_user_id uuid)
returns table (account_number text, pan text)
language sql
security definer
set search_path = ''
stable
as $$
  select a.decrypted_secret, p.decrypted_secret
  from public.host_payout_accounts h
  left join vault.decrypted_secrets a on a.id = h.account_number_secret_id
  left join vault.decrypted_secrets p on p.id = h.pan_secret_id
  where h.user_id = _user_id;
$$;

create function public.host_payout_account_remove(_user_id uuid) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  _row public.host_payout_accounts;
begin
  delete from public.host_payout_accounts where user_id = _user_id returning * into _row;
  if not found then return false; end if;
  delete from vault.secrets where id in (_row.account_number_secret_id, _row.pan_secret_id);
  return true;
end $$;

revoke all on function public.host_payout_account_save(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.host_payout_account_reveal(uuid) from public, anon, authenticated;
revoke all on function public.host_payout_account_remove(uuid) from public, anon, authenticated;
grant execute on function public.host_payout_account_save(uuid, text, text, text, text, text) to service_role;
grant execute on function public.host_payout_account_reveal(uuid) to service_role;
grant execute on function public.host_payout_account_remove(uuid) to service_role;

-- Payouts ---------------------------------------------------------------------------------------

create table public.host_payouts (
  id uuid primary key default gen_random_uuid(),
  -- No cascade: a payout is a financial record and outlives profile changes.
  host_id uuid not null references public.profiles (id),
  amount_minor_units integer not null check (amount_minor_units > 0),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  -- The bank's reference for the transfer (UTR / IMPS / NEFT reference).
  reference text not null check (char_length(btrim(reference)) between 1 and 100),
  paid_at timestamptz not null,
  note text check (note is null or char_length(note) <= 1000),
  -- Where it was sent, as it was at the time.
  account_last4 text,
  ifsc text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index host_payouts_host_paid_idx on public.host_payouts (host_id, paid_at desc);

create table public.host_payout_items (
  payout_id uuid not null references public.host_payouts (id) on delete cascade,
  booking_id uuid not null unique references public.bookings (id),
  amount_minor_units integer not null check (amount_minor_units >= 0),
  primary key (payout_id, booking_id)
);

comment on table public.host_payouts is 'Payouts the team sent to hosts. Service role only.';
comment on table public.host_payout_items is 'Which bookings each payout covered; a booking is paid out at most once.';

alter table public.host_payouts enable row level security;
alter table public.host_payout_items enable row level security;

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
    'ADMIN_RECORDED_PAYOUT'
  )
);

alter table public.admin_audit_log add constraint admin_audit_log_target_type_check check (
  target_type in (
    'location', 'user', 'booking', 'payment', 'media', 'section', 'catalog_item', 'settings',
    'collection', 'campaign', 'channel', 'platform', 'feature_flag', 'incident', 'release',
    'site_integration', 'site', 'site_page', 'seo', 'refund_request', 'deletion_request',
    'payout_account', 'payout'
  )
);

-- ============================================================================
-- Email outbox: every transactional email (bookings, payments, listings, payouts) is written here
-- first, then sent -- straight away when possible, and retried by the background job dispatcher
-- when sending fails. One row per event and person (`idempotency_key`), so a retried event never
-- sends twice. The email is rendered at send time from `template` + `data`, so it always carries
-- the latest booking details. Service role only; the admin console reads it through the API.
-- ============================================================================

create table public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id) on delete set null,
  to_email text not null check (char_length(to_email) between 3 and 320),
  template text not null check (char_length(template) between 1 and 60),
  stream text not null default 'transactional' check (stream in ('transactional', 'marketing')),
  idempotency_key text not null unique check (char_length(idempotency_key) <= 200),
  data jsonb not null default '{}'::jsonb,
  subject text,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  provider_message_id text,
  send_after timestamptz not null default now(),
  locked_until timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.email_outbox is
  'Transactional emails: queued, sent (with retries) and logged. Written and read by the backend only.';

create index email_outbox_due_idx on public.email_outbox (send_after) where status = 'queued';
create index email_outbox_user_idx on public.email_outbox (user_id, created_at desc);
create index email_outbox_created_idx on public.email_outbox (created_at desc);

alter table public.email_outbox enable row level security;
revoke all on table public.email_outbox from anon, authenticated;
grant select, insert, update, delete on public.email_outbox to service_role;

create trigger email_outbox_set_updated_at before update on public.email_outbox
  for each row execute function public.set_updated_at();

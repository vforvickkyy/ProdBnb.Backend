-- Admin Console 5: unpaid hold expiry.
--
-- ============================================================================
-- THE PROBLEM
--
-- A booking reserves its interval the moment it is created (`requested`/`confirmed` participate in
-- bookings' EXCLUDE constraint), whether or not anyone ever pays. Since Phase 29.14-D a host is
-- neither shown nor notified about an unpaid booking -- so an abandoned checkout blocked the host's
-- calendar indefinitely, invisibly, with nothing the host could do about it.
--
-- ============================================================================
-- THE RULE
--
-- With platform_settings.unpaid_hold_minutes = N (null = off, the default, i.e. today's behaviour),
-- a booking is expired -- moved to `cancelled`, which releases the interval immediately -- when ALL
-- of these hold:
--
--   1. status is `requested` or `confirmed`
--   2. it was created more than N minutes ago
--   3. it has no settled payment (success / partially_refunded / refunded -- the exact predicate of
--      payments_one_settled_per_booking)
--   4. it has no payment attempt that could still succeed: an in-flight (`created`/`pending`)
--      attempt protects the booking until its provider order expires (`payments.expires_at`, set by
--      payment.service.ts when holds are on), or for 60 minutes after creation when no expiry was
--      recorded (attempts made before this migration / while holds were off).
--
-- Rule 4 is what stops a booker who is mid-checkout from paying for a booking that was cancelled
-- underneath them. A payment that nonetheless settles on an expired booking (e.g. a long-delayed
-- webhook) is surfaced to admins as "paid but cancelled" for a refund decision; it is never
-- silently swallowed.
--
-- Expiry writes `hold_expired_at` (how admins and clients can tell an expiry from a person
-- cancelling), leaves `cancelled_by` null (no person did it), and records an in-app
-- `booking_cancelled` notification for the booker using the exact source_event_id the manual cancel
-- path uses -- a booking can only ever be cancelled once, so the two can never collide. No push is
-- sent from SQL (no outbound HTTP from Postgres); the in-app record is always written.
--
-- ============================================================================
-- WHEN IT RUNS
--
--   * pg_cron, every minute, platform-wide (if pg_cron is available -- guarded below).
--   * Lazily, scoped to one location, from the backend immediately before it computes availability
--     or creates a booking -- so correctness never depends on the cron's timing.
-- ============================================================================

alter table public.bookings add column hold_expired_at timestamptz;
comment on column public.bookings.hold_expired_at is
  'Set when the booking was auto-cancelled because payment was not completed within '
  'platform_settings.unpaid_hold_minutes. Null for every other booking.';

alter table public.payments add column expires_at timestamptz;
comment on column public.payments.expires_at is
  'When the provider order for this attempt stops being payable (the order_expiry_time we sent). '
  'Null for attempts created while unpaid-hold expiry was off.';

create index bookings_unpaid_hold_candidates_idx
  on public.bookings (created_at)
  where status in ('requested', 'confirmed');

create function public.expire_unpaid_bookings(_location_id uuid default null)
returns setof uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  _minutes integer;
begin
  select unpaid_hold_minutes into _minutes from public.platform_settings where singleton;
  if _minutes is null then
    return;
  end if;

  return query
  with expired as (
    update public.bookings b
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = null,
        cancellation_reason = 'Payment was not completed in time.',
        hold_expired_at = now()
    where b.status in ('requested', 'confirmed')
      and b.created_at < now() - make_interval(mins => _minutes)
      and (_location_id is null or b.location_id = _location_id)
      and not exists (
        select 1 from public.payments p
        where p.booking_id = b.id and p.status in ('success', 'partially_refunded', 'refunded')
      )
      and not exists (
        select 1 from public.payments p
        where p.booking_id = b.id
          and p.status in ('created', 'pending')
          and coalesce(p.expires_at, p.created_at + interval '60 minutes') > now()
      )
    returning b.id, b.booker_id
  ),
  notified as (
    insert into public.notifications (user_id, type, title, body, entity_type, entity_id, data, source_event_id)
    select e.booker_id,
           'booking_cancelled',
           'Booking cancelled',
           'Your booking was cancelled because payment was not completed in time.',
           'booking',
           e.id,
           jsonb_build_object('reason', 'unpaid_hold_expired'),
           'booking:' || e.id || ':booking_cancelled'
    from expired e
    on conflict (user_id, source_event_id) do nothing
    returning 1
  )
  select e.id from expired e;
end;
$$;

revoke all on function public.expire_unpaid_bookings(uuid) from public, anon, authenticated;
grant execute on function public.expire_unpaid_bookings(uuid) to service_role;

-- pg_cron sweep. Guarded: if the extension cannot be created on this project the migration still
-- succeeds, and the backend's lazy per-location expiry keeps the rule correct on its own.
do $$
begin
  begin
    create extension if not exists pg_cron with schema pg_catalog;
  exception when others then
    raise notice 'pg_cron unavailable (%); unpaid-hold expiry will run lazily from the backend only.', sqlerrm;
    return;
  end;

  perform cron.schedule('prodbnb-expire-unpaid-bookings', '* * * * *', 'select public.expire_unpaid_bookings()');
exception when others then
  raise notice 'Could not schedule unpaid-hold expiry (%); lazy expiry still applies.', sqlerrm;
end $$;

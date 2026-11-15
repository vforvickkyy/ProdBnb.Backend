-- Admin Console 6: analytics for the Admin Console.
--
-- One read-only function returning one jsonb document, so an analytics page is a single round trip
-- rather than a dozen aggregate queries over PostgREST. service_role only: the backend calls it
-- after its own `analytics.view` permission check, the same "authorize in the API, execute as
-- service role" shape every Admin Console write already uses.
--
-- Definitions (documented here because a number without a definition is not information):
--
--   new_users          profiles created in range
--   new_listings       locations created in range (any status)
--   bookings_created   bookings created in range (any status)
--   bookings_paid      bookings created in range that have a settled payment
--   gmv_minor          sum of settled payments' amount, by payment creation time, in `currency`
--   refunds_minor      sum of successful refunds, by refund creation time, in `currency`
--   platform_fee_minor sum of bookings.platform_fee_minor_units over bookings_paid
--   payment_success_rate  settled attempts / attempts that reached any terminal state, in range
--   expired_holds      bookings auto-cancelled by unpaid-hold expiry, by expiry time
--
-- Money is summed for ONE currency only (`_currency`, default INR); attempts in any other currency
-- are counted separately in `other_currency_payments` rather than silently mixed in.
-- Buckets are calendar day/week/month in `_tz` (default Asia/Kolkata), not UTC, so "Monday" means
-- the operator's Monday.

create function public.admin_analytics(
  _from timestamptz,
  _to timestamptz,
  _bucket text default 'day',
  _tz text default 'Asia/Kolkata',
  _currency text default 'INR'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  _result jsonb;
  _step interval;
begin
  if _bucket not in ('day', 'week', 'month') then
    raise exception 'invalid_bucket' using errcode = '22023';
  end if;
  if _to <= _from then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if _to - _from > interval '400 days' then
    raise exception 'range_too_large' using errcode = '22023';
  end if;

  _step := case _bucket when 'day' then interval '1 day' when 'week' then interval '1 week' else interval '1 month' end;

  with
  settled as (
    select p.booking_id, p.amount_minor_units, p.currency, p.created_at
    from payments p
    where p.status in ('success', 'partially_refunded', 'refunded')
  ),
  buckets as (
    select generate_series(
      date_trunc(_bucket, _from at time zone _tz),
      date_trunc(_bucket, (_to - interval '1 microsecond') at time zone _tz),
      _step
    ) as bucket_start
  ),
  series as (
    select
      b.bucket_start,
      (select count(*) from profiles pr
        where date_trunc(_bucket, pr.created_at at time zone _tz) = b.bucket_start
          and pr.created_at >= _from and pr.created_at < _to) as new_users,
      (select count(*) from bookings bk
        where date_trunc(_bucket, bk.created_at at time zone _tz) = b.bucket_start
          and bk.created_at >= _from and bk.created_at < _to) as bookings_created,
      (select count(*) from bookings bk
        where date_trunc(_bucket, bk.created_at at time zone _tz) = b.bucket_start
          and bk.created_at >= _from and bk.created_at < _to
          and exists (select 1 from settled s where s.booking_id = bk.id)) as bookings_paid,
      (select coalesce(sum(s.amount_minor_units), 0) from settled s
        where date_trunc(_bucket, s.created_at at time zone _tz) = b.bucket_start
          and s.created_at >= _from and s.created_at < _to
          and s.currency = _currency) as gmv_minor
    from buckets b
  ),
  range_bookings as (
    select bk.* from bookings bk where bk.created_at >= _from and bk.created_at < _to
  ),
  terminal_attempts as (
    select p.status, p.currency from payments p
    where p.created_at >= _from and p.created_at < _to
      and p.status in ('success', 'partially_refunded', 'refunded', 'failed', 'cancelled')
  )
  select jsonb_build_object(
    'range', jsonb_build_object('from', _from, 'to', _to, 'bucket', _bucket, 'timezone', _tz, 'currency', _currency),
    'totals', jsonb_build_object(
      'new_users', (select count(*) from profiles where created_at >= _from and created_at < _to),
      'new_listings', (select count(*) from locations where created_at >= _from and created_at < _to),
      'published_listings', (select count(*) from locations where status = 'published'),
      'bookings_created', (select count(*) from range_bookings),
      'bookings_paid', (select count(*) from range_bookings rb where exists (select 1 from settled s where s.booking_id = rb.id)),
      'gmv_minor', (select coalesce(sum(amount_minor_units), 0) from settled
                     where created_at >= _from and created_at < _to and currency = _currency),
      'refunds_minor', (select coalesce(sum(r.amount_minor_units), 0) from payment_refunds r
                         join payments p on p.id = r.payment_id
                         where r.status = 'success' and r.created_at >= _from and r.created_at < _to
                           and p.currency = _currency),
      'platform_fee_minor', (select coalesce(sum(rb.platform_fee_minor_units), 0) from range_bookings rb
                              where rb.currency = _currency
                                and exists (select 1 from settled s where s.booking_id = rb.id)),
      'payment_success_rate', (select case when count(*) = 0 then null
                                  else round(count(*) filter (where status in ('success','partially_refunded','refunded'))::numeric / count(*), 4) end
                                from terminal_attempts),
      'cancellations', (select count(*) from bookings where status = 'cancelled'
                         and cancelled_at >= _from and cancelled_at < _to),
      'expired_holds', (select count(*) from bookings where hold_expired_at >= _from and hold_expired_at < _to),
      'other_currency_payments', (select count(*) from terminal_attempts where currency <> _currency)
    ),
    'series', coalesce((select jsonb_agg(jsonb_build_object(
        'bucket_start', to_char(s.bucket_start, 'YYYY-MM-DD'),
        'new_users', s.new_users,
        'bookings_created', s.bookings_created,
        'bookings_paid', s.bookings_paid,
        'gmv_minor', s.gmv_minor
      ) order by s.bucket_start) from series s), '[]'::jsonb),
    'status_breakdown', coalesce((select jsonb_object_agg(status, n) from
        (select status, count(*) as n from range_bookings group by status) x), '{}'::jsonb),
    'booking_type_breakdown', coalesce((select jsonb_object_agg(booking_type, n) from
        (select booking_type, count(*) as n from range_bookings group by booking_type) x), '{}'::jsonb),
    'top_locations', coalesce((select jsonb_agg(t) from (
        select l.id, l.title, l.city,
               count(distinct s.booking_id) as paid_bookings,
               coalesce(sum(s.amount_minor_units), 0) as gmv_minor
        from settled s
        join bookings bk on bk.id = s.booking_id
        join locations l on l.id = bk.location_id
        where s.created_at >= _from and s.created_at < _to and s.currency = _currency
        group by l.id, l.title, l.city
        order by gmv_minor desc, paid_bookings desc
        limit 10) t), '[]'::jsonb),
    'top_cities', coalesce((select jsonb_agg(t) from (
        select l.city, count(*) as bookings
        from range_bookings rb join locations l on l.id = rb.location_id
        group by l.city order by bookings desc, l.city limit 10) t), '[]'::jsonb)
  ) into _result;

  return _result;
end;
$$;

revoke all on function public.admin_analytics(timestamptz, timestamptz, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_analytics(timestamptz, timestamptz, text, text, text) to service_role;

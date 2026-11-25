-- ============================================================================
-- Background jobs also wake up for email work, not only for announcements.
--
-- dispatch_background_jobs() (pg_cron, every minute) used to call the backend only while an
-- announcement was sending or due, so a booking email that failed the first time was never
-- retried and nothing sent the day-before reminders. It now also calls when:
--   * an email in the outbox is due for (another) try, or one is stuck mid-send;
--   * a confirmed booking starts in 20-28 hours and its reminder hasn't been queued yet.
-- Otherwise unchanged: off until an admin enables it, and quiet when there is nothing to do.
-- ============================================================================

create index if not exists bookings_confirmed_start_idx on public.bookings (start_at) where status = 'confirmed';

create or replace function public.dispatch_background_jobs() returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  _cfg public.background_jobs_config;
begin
  select * into _cfg from public.background_jobs_config where singleton;
  if not found or not _cfg.enabled or _cfg.dispatch_url is null then
    return false;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    return false;
  end if;
  if not exists (
       select 1 from public.notification_campaigns
       where status = 'sending' or (status = 'scheduled' and scheduled_at <= now())
     )
     and not exists (
       select 1 from public.email_outbox
       where (status = 'queued' and send_after <= now())
          or (status = 'sending' and locked_until < now())
     )
     and not exists (
       select 1 from public.bookings b
       where b.status = 'confirmed'
         and b.start_at between now() + interval '20 hours' and now() + interval '28 hours'
         and not exists (
           select 1 from public.email_outbox o where o.idempotency_key = 'reminder:' || b.id::text || ':booker'
         )
     )
  then
    return false;
  end if;

  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 60000)'
  using
    _cfg.dispatch_url,
    '{}'::jsonb,
    jsonb_build_object(
      'Content-Type', 'application/json',
      'X-ProdBnb-Job-Secret', public.system_secret('prodbnb_jobs_secret')
    );

  update public.background_jobs_config set last_tick_at = now() where id = _cfg.id;
  return true;
end $$;

revoke all on function public.dispatch_background_jobs() from public, anon, authenticated;
grant execute on function public.dispatch_background_jobs() to service_role;

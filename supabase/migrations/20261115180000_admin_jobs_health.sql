-- Admin Console 2: can scheduled / background campaign sending actually run here?
-- Reports whether pg_net and pg_cron are installed and the dispatch job is scheduled, so the
-- Messaging page can say exactly what is missing instead of silently never sending.

create function public.admin_jobs_health() returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  _cron boolean := exists (select 1 from pg_extension where extname = 'pg_cron');
  _job boolean := false;
begin
  if _cron then
    execute 'select exists (select 1 from cron.job where jobname = $1)' into _job using 'prodbnb-dispatch-background-jobs';
  end if;
  return jsonb_build_object(
    'pg_net', exists (select 1 from pg_extension where extname = 'pg_net'),
    'pg_cron', _cron,
    'dispatch_job_scheduled', _job
  );
end $$;

revoke all on function public.admin_jobs_health() from public, anon, authenticated;
grant execute on function public.admin_jobs_health() to service_role;

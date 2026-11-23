-- ============================================================================
-- Host onboarding help: "Request a callback"
--
-- A signed-in person who wants to list a place can ask the team to call them and help them get
-- listed. They leave a name and phone number (prefilled from their profile), and optionally their
-- city, the kind of space, a good time to call, a note, and the draft listing they have started.
-- The admin team works the list in the console: New -> Contacted -> Done (or Closed), with notes.
--
-- One open request per person (New or Contacted): asking again updates that request instead of
-- filing a duplicate. The person can withdraw an open request.
--
-- Writes go through the backend (service role) only. The person may read their own requests.
-- ============================================================================

create table public.host_assistance_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- The draft they had started when they asked, if any. Deleting that listing keeps the request.
  location_id uuid references public.locations (id) on delete set null,
  name text not null check (char_length(name) between 1 and 120),
  phone text not null check (char_length(phone) between 5 and 32),
  -- Their sign-in email when they asked, so the team has a second way to reach them.
  email text check (email is null or char_length(email) <= 254),
  city text check (city is null or char_length(city) <= 120),
  space_type text check (space_type is null or char_length(space_type) <= 120),
  best_time text not null default 'anytime' check (best_time in ('morning', 'afternoon', 'evening', 'anytime')),
  note text check (note is null or char_length(note) <= 1000),
  -- Where they asked from: the iPhone app, the Android app or the website.
  source text not null default 'web' check (source in ('ios', 'android', 'web')),
  status text not null default 'new' check (status in ('new', 'contacted', 'done', 'closed', 'withdrawn')),
  admin_notes text check (admin_notes is null or char_length(admin_notes) <= 2000),
  handled_by uuid references public.profiles (id) on delete set null,
  contacted_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.host_assistance_requests is
  'A person asking the team to call them and help them list a place. Writes through the backend only.';

create unique index host_assistance_requests_one_open_per_user
  on public.host_assistance_requests (user_id) where status in ('new', 'contacted');
create index host_assistance_requests_status_created_idx
  on public.host_assistance_requests (status, created_at desc);
create index host_assistance_requests_user_idx
  on public.host_assistance_requests (user_id, created_at desc);

alter table public.host_assistance_requests enable row level security;

create policy host_assistance_requests_select_own on public.host_assistance_requests
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Revoke all, then grant explicitly (the pattern since Phase 29.6).
revoke all on table public.host_assistance_requests from anon, authenticated;
grant select on public.host_assistance_requests to authenticated;
grant select, insert, update, delete on public.host_assistance_requests to service_role;

create trigger host_assistance_requests_set_updated_at before update on public.host_assistance_requests
  for each row execute function public.set_updated_at();

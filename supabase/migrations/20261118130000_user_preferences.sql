-- Onboarding answers: who someone is and what they shoot, so the website can welcome them properly,
-- search can lean their way, and the team can send them notifications that are relevant.
--
-- The required basics live where they always have: name and mobile on `profiles`. `professions`
-- is the third required answer ("what do you do"); everything else is optional and can be
-- finished later from the account. The backend decides what "onboarded" means (see
-- src/modules/users/preferences.service.ts); nothing else in the platform is gated on it.
--
-- Service role only: the API reads and writes it for the signed-in user.

create table public.user_preferences (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  professions text[] not null default '{}' check (
    cardinality(professions) <= 5
    and professions <@ array[
      'producer', 'director', 'cinematographer', 'photographer', 'production_house', 'ad_agency',
      'content_creator', 'art_director', 'location_manager', 'student', 'location_owner', 'other'
    ]::text[]
  ),
  company text check (company is null or char_length(company) between 1 and 120),
  cities text[] not null default '{}' check (cardinality(cities) <= 10),
  use_case_ids uuid[] not null default '{}' check (cardinality(use_case_ids) <= 10),
  category_ids uuid[] not null default '{}' check (cardinality(category_ids) <= 10),
  heard_from text check (heard_from is null or heard_from in ('search', 'social', 'friend', 'event', 'press', 'other')),
  new_listing_alerts boolean not null default true,
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.user_preferences is 'Onboarding answers (profession, cities, shoot types). Service role only.';

create index user_preferences_professions_idx on public.user_preferences using gin (professions);
create index user_preferences_cities_idx on public.user_preferences using gin (cities);

alter table public.user_preferences enable row level security;
create trigger user_preferences_set_updated_at before update on public.user_preferences
  for each row execute function public.set_updated_at();

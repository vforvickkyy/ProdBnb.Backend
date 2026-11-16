-- Contacts after booking.
--
-- location_private_details: what a host shares only with confirmed bookers -- an on-site contact
-- and arrival notes (gate code, parking, which entrance). Never part of the public listing.
-- Service role only: the API reads it for the listing's owner (to edit) and for a confirmed,
-- paid booking's booker (to show), and nobody else.

create table public.location_private_details (
  location_id uuid primary key references public.locations (id) on delete cascade,
  onsite_contact_name text check (onsite_contact_name is null or char_length(btrim(onsite_contact_name)) between 1 and 120),
  onsite_contact_phone text check (onsite_contact_phone is null or onsite_contact_phone ~ '^\+?[0-9 ()\-.]{5,32}$'),
  arrival_notes text check (arrival_notes is null or char_length(arrival_notes) <= 2000),
  updated_at timestamptz not null default now()
);

comment on table public.location_private_details is
  'On-site contact and arrival notes a host shares with confirmed bookers only. Service role only.';

alter table public.location_private_details enable row level security;
create trigger location_private_details_set_updated_at before update on public.location_private_details
  for each row execute function public.set_updated_at();

-- Admin Console 1: table-privilege hardening for the client roles (anon, authenticated).
--
-- ============================================================================
-- WHY
--
-- Supabase ships `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,
-- authenticated, service_role`. Every table this project created therefore arrived with
-- SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER already granted to BOTH client roles,
-- and each migration's own `grant select ...` was additive on top of that rather than the whole
-- truth. Measured against a fresh local stack (CLI 2.122) before this migration:
--
--   admin_audit_log, admin_message_access, messages, conversations, payments, payment_refunds,
--   payment_webhook_events, notification_delivery_attempts, catalog tables, ...  -> ALL to anon
--   AND authenticated
--
-- Row Level Security is what has actually been refusing those writes (no INSERT/UPDATE/DELETE
-- policy exists), which is why nothing was ever exploitable through PostgREST -- but the writes
-- failed as silent zero-row no-ops instead of `42501`, the grant layer carried none of the
-- defence in depth the earlier migrations describe, and TRUNCATE is not subject to RLS at all.
-- docs/DATABASE.md ("Messaging data model -> RLS") recorded exactly this on staging and named
-- this pass as the follow-up.
--
-- ============================================================================
-- WHAT
--
-- For every application table in `public`: revoke everything from anon and authenticated, then
-- grant back precisely the privileges the earlier migrations intended -- table-level and
-- column-level -- collected from those migrations in order. Nothing is granted that was not
-- already intended; service_role is untouched. RLS policies are untouched.
--
-- Revoking a table privilege also revokes that table's column privileges (PostgreSQL docs,
-- REVOKE), which is why the column grants on profiles / locations / location_media are restated.
--
-- Default privileges are deliberately NOT altered here: they are Supabase's platform defaults
-- (the dashboard's table editor relies on them). New tables keep following the established
-- "revoke all, then grant explicitly" pattern in their own migration instead (Phase 29.6 onward).
-- ============================================================================

do $$
declare
  _table text;
begin
  foreach _table in array array[
    'profiles', 'user_roles',
    'categories', 'amenities', 'use_cases',
    'locations', 'location_categories', 'location_amenities', 'location_use_cases',
    'location_media', 'location_sections',
    'location_availability_rules', 'location_availability_overrides', 'location_blocked_periods',
    'location_pricing', 'bookings',
    'payments', 'payment_refunds', 'payment_webhook_events',
    'user_devices', 'notifications', 'notification_preferences', 'notification_delivery_attempts',
    'admin_audit_log',
    'conversations', 'messages', 'conversation_reads', 'admin_message_access',
    'user_billing_profiles'
  ]
  loop
    execute format('revoke all on table public.%I from anon, authenticated', _table);
  end loop;
end $$;

-- -- Phase 1 --------------------------------------------------------------------
grant select on public.profiles to authenticated;
grant update (
  first_name, last_name, avatar_url,
  -- Phase 26-MB
  phone, address_line1, address_line2, address_city, address_region, address_country, address_postal_code
) on public.profiles to authenticated;

grant select, insert, delete on public.user_roles to authenticated;

-- -- Phase 2 (+ Phase 12 column restrictions) ------------------------------------
grant select on public.categories, public.amenities, public.use_cases to anon, authenticated;

grant select on public.locations to anon, authenticated;
grant delete on public.locations to authenticated;
grant insert (
  host_id, title, description,
  address_line1, address_line2, city, region, country, postal_code,
  latitude, longitude, capacity, timezone, instant_booking_enabled
) on public.locations to authenticated;
grant update (
  title, description,
  address_line1, address_line2, city, region, country, postal_code,
  latitude, longitude, capacity, timezone, instant_booking_enabled
) on public.locations to authenticated;

grant select on public.location_categories, public.location_amenities, public.location_use_cases to anon;
grant select, insert, delete on public.location_categories, public.location_amenities, public.location_use_cases
  to authenticated;

-- -- Phase 3 / 12 / 29.5: media -- reads, ownership-gated delete, and the reorder grant -----------
grant select on public.location_media to anon, authenticated;
grant delete on public.location_media to authenticated;
grant update (position) on public.location_media to authenticated;

-- -- Phase 29.6: sections (unchanged from that migration's own explicit grants) ------------------
grant select on public.location_sections to anon;
grant select, insert, update, delete on public.location_sections to authenticated;

-- -- Phase 5 ----------------------------------------------------------------------
grant select on public.location_availability_rules, public.location_availability_overrides to anon;
grant select, insert, update, delete
  on public.location_availability_rules, public.location_availability_overrides, public.location_blocked_periods
  to authenticated;

-- -- Phase 6 / 6A / 12 ------------------------------------------------------------
grant select on public.location_pricing to anon;
grant select, insert, update, delete on public.location_pricing to authenticated;
grant select on public.bookings to authenticated;

-- -- Phase 7 ----------------------------------------------------------------------
grant select on public.payments, public.payment_refunds to authenticated;
-- payment_webhook_events: internal ledger, no client access at all.

-- -- Phase 8 ----------------------------------------------------------------------
grant select, update on public.user_devices to authenticated;
grant select, update on public.notifications to authenticated;
grant select, insert, update on public.notification_preferences to authenticated;
-- notification_delivery_attempts: internal audit, no client access at all.

-- -- Phase 11 ---------------------------------------------------------------------
grant select on public.admin_audit_log to authenticated;

-- -- Phase 27 ---------------------------------------------------------------------
grant select on public.conversations, public.messages, public.conversation_reads, public.admin_message_access
  to authenticated;

-- -- Phase 29.17-G ----------------------------------------------------------------
grant select, insert, update, delete on public.user_billing_profiles to authenticated;

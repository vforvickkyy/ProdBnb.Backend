-- Admin Console 2: widen admin_audit_log's closed vocabulary for the Admin Console's new actions.
--
-- Purely widening: every existing value stays valid, so no row can be invalidated and nothing is
-- backfilled. Constraints are looked up and dropped dynamically (the Phase 12 technique), never by
-- a guessed auto-generated name.
--
-- New actions
--   Bookings   ADMIN_CONFIRMED_BOOKING, ADMIN_REJECTED_BOOKING, ADMIN_COMPLETED_BOOKING
--   Payments   ADMIN_VERIFIED_PAYMENT
--   Listings   ADMIN_UPDATED_LOCATION (content edit), ADMIN_DELETED_MEDIA, ADMIN_DELETED_SECTION
--   Catalog    ADMIN_CREATED_CATALOG_ITEM, ADMIN_UPDATED_CATALOG_ITEM, ADMIN_DELETED_CATALOG_ITEM
--   People     ADMIN_GRANTED_ROLE, ADMIN_REVOKED_ROLE (booker/host only)
--   Team       ADMIN_SET_TEAM_ROLE, ADMIN_REMOVED_TEAM_MEMBER
--   Platform   ADMIN_UPDATED_SETTINGS
--
-- New target types: media, section, catalog_item, settings.
--
-- Reading a private conversation is deliberately NOT an audit action: that act already has its own,
-- stricter ledger (admin_message_access, Phase 27-1, reason NOT NULL and non-blank).

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
    'ADMIN_UPDATED_SETTINGS'
  )
);

alter table public.admin_audit_log add constraint admin_audit_log_target_type_check check (
  target_type in ('location', 'user', 'booking', 'payment', 'media', 'section', 'catalog_item', 'settings')
);

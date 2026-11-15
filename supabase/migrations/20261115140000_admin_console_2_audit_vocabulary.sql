-- Admin Console 2: widen admin_audit_log's closed vocabulary again.
--
-- Purely widening, exactly like 20261115095000: every existing value is re-listed, so no row can
-- be invalidated and nothing is backfilled. Constraints are found and dropped dynamically.
--
-- New actions
--   Listings     ADMIN_CREATED_LOCATION (on behalf of a host), ADMIN_UPLOADED_MEDIA,
--                ADMIN_REORDERED_MEDIA, ADMIN_UPDATED_PRICING, ADMIN_UPDATED_AVAILABILITY,
--                ADMIN_UPDATED_SECTION
--   Catalog      ADMIN_UPDATED_CATALOG_LISTINGS, ADMIN_UPDATED_CATALOG_COVER
--   Collections  ADMIN_CREATED_COLLECTION, ADMIN_UPDATED_COLLECTION, ADMIN_DELETED_COLLECTION
--   Messaging    ADMIN_SENT_CAMPAIGN, ADMIN_CANCELLED_CAMPAIGN, ADMIN_CONNECTED_CHANNEL,
--                ADMIN_DISCONNECTED_CHANNEL, ADMIN_UPDATED_JOBS_CONFIG
--   Platforms    ADMIN_UPDATED_PLATFORM, ADMIN_UPDATED_FEATURE_FLAG, ADMIN_DELETED_FEATURE_FLAG,
--                ADMIN_CREATED_INCIDENT, ADMIN_UPDATED_INCIDENT, ADMIN_CREATED_RELEASE,
--                ADMIN_UPDATED_RELEASE, ADMIN_DELETED_RELEASE
--
-- New target types: collection, campaign, channel, platform, feature_flag, incident, release.
-- Every one of those tables has a uuid primary key, because admin_audit_log.target_id is uuid.

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
    'ADMIN_UPDATED_SETTINGS',
    -- Admin Console 2
    'ADMIN_CREATED_LOCATION',
    'ADMIN_UPLOADED_MEDIA',
    'ADMIN_REORDERED_MEDIA',
    'ADMIN_UPDATED_PRICING',
    'ADMIN_UPDATED_AVAILABILITY',
    'ADMIN_UPDATED_SECTION',
    'ADMIN_UPDATED_CATALOG_LISTINGS',
    'ADMIN_UPDATED_CATALOG_COVER',
    'ADMIN_CREATED_COLLECTION',
    'ADMIN_UPDATED_COLLECTION',
    'ADMIN_DELETED_COLLECTION',
    'ADMIN_SENT_CAMPAIGN',
    'ADMIN_CANCELLED_CAMPAIGN',
    'ADMIN_CONNECTED_CHANNEL',
    'ADMIN_DISCONNECTED_CHANNEL',
    'ADMIN_UPDATED_JOBS_CONFIG',
    'ADMIN_UPDATED_PLATFORM',
    'ADMIN_UPDATED_FEATURE_FLAG',
    'ADMIN_DELETED_FEATURE_FLAG',
    'ADMIN_CREATED_INCIDENT',
    'ADMIN_UPDATED_INCIDENT',
    'ADMIN_CREATED_RELEASE',
    'ADMIN_UPDATED_RELEASE',
    'ADMIN_DELETED_RELEASE'
  )
);

alter table public.admin_audit_log add constraint admin_audit_log_target_type_check check (
  target_type in (
    'location', 'user', 'booking', 'payment', 'media', 'section', 'catalog_item', 'settings',
    'collection', 'campaign', 'channel', 'platform', 'feature_flag', 'incident', 'release'
  )
);

-- ============================================================================
-- Defence in depth: signed-out visitors (the public "anon" key every browser has) lose all access
-- to tables that hold private data. Row security already returns nothing to them on every one of
-- these (none has an anon policy), so nothing changes today; this makes sure a future policy
-- mistake can't expose them through the public key. No client reads these tables directly: the
-- website, admin and apps go through the API.
-- ============================================================================

revoke all on table
  public.account_deletion_requests,
  public.coupon_redemptions,
  public.coupons,
  public.host_payout_accounts,
  public.host_payout_items,
  public.host_payouts,
  public.invoice_counters,
  public.invoice_events,
  public.invoice_settings,
  public.invoices,
  public.location_private_details,
  public.notification_templates,
  public.refund_requests,
  public.site_integrations,
  public.user_preferences
from anon;

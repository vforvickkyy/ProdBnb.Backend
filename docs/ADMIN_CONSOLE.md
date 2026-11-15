# Admin Console (backend)

The backend half of the ProdBnb Admin Console: admin team roles, platform settings, unpaid-hold
expiry, dispute message access, catalog management, listing moderation, booking/payment
operations, analytics, and the integrations & secrets status page. The Admin Panel
(`ProdBnb-Admin`) is the only consumer; every endpoint lives under `/v1/admin/*` and is in the
generated contract `docs/admin-openapi.json`.

Migrations (apply in order; each is independent of the ones after it):

| Migration | What it does |
|---|---|
| `20261115090000_grant_hardening.sql` | Table-privilege hardening for `anon`/`authenticated` on every table — see [Grant hardening](#grant-hardening) |
| `20261115095000_admin_audit_vocabulary.sql` | Widens `admin_audit_log.action`/`target_type` for the new actions |
| `20261115100000_admin_team_roles.sql` | `admin_team_members`, sync triggers, team functions, closes the `user_roles` admin-arm escalation |
| `20261115110000_platform_settings.sql` | `platform_settings` (single row; defaults = today's behaviour) |
| `20261115120000_unpaid_hold_expiry.sql` | `bookings.hold_expired_at`, `payments.expires_at`, `expire_unpaid_bookings()`, pg_cron sweep |
| `20261115130000_admin_analytics.sql` | `admin_analytics()` |

**Nothing changes for any iOS user when these are applied.** Fee and tax default to 0 and hold
expiry defaults to off; each only takes effect when a super admin changes it.

## Team roles

`user_roles.role = 'admin'` is still the platform-level "is an administrator" fact that every RLS
policy reads. `admin_team_members` refines it with exactly one team role per admin, enforced by the
`/v1/admin/*` layer. Triggers keep the two in sync, so the documented SQL bootstrap (insert a
`user_roles` `admin` row with the service-role key — see `docs/DATABASE.md`) still works and
produces a **super admin**.

| Permission | super_admin | moderator | support | finance |
|---|:-:|:-:|:-:|:-:|
| dashboard.view, users.view, locations.view, bookings.view, audit.view, settings.view, platforms.view | ✓ | ✓ | ✓ | ✓ |
| users.manage (suspend/restore, grant/revoke booker/host) | ✓ | ✓ | | |
| locations.moderate (approve/reject/suspend/restore, edit content, remove photos/sections) | ✓ | ✓ | | |
| locations.create (create a listing for a host) | ✓ | ✓ | | |
| catalog.manage (catalog items, covers, collections) | ✓ | ✓ | | |
| campaigns.view | ✓ | ✓ | ✓ | |
| campaigns.send (announcements, direct notifications) | ✓ | | ✓ | |
| incidents.manage | ✓ | | ✓ | |
| bookings.manage (cancel/confirm/reject/complete on a host's behalf) | ✓ | | ✓ | |
| payments.view, payments.verify | ✓ | | ✓ | ✓ |
| payments.refund | ✓ | | | ✓ |
| messages.access (read a private conversation for a stated reason) | ✓ | | ✓ | |
| notifications.diagnostics | ✓ | | ✓ | |
| analytics.view | ✓ | | | ✓ |
| team.manage, settings.manage, system.view, channels.manage, platforms.manage | ✓ | | | |

The matrix lives in one place, `src/modules/admin/permissions.ts`; the Admin Panel reads the
caller's permissions back from `GET /v1/admin/me` and never keeps its own copy.

**The same gate on every door.** The older, shared routes that accept an admin caller —
`PATCH /v1/locations/:id`, `POST /v1/bookings/:id/cancel|confirm|reject|complete`,
`POST /v1/payments/:id/refunds`, and the media/sections/pricing/availability write routes — now
check the matching permission (`callerHasAdminPermission`) instead of bare admin membership, so a
Support admin cannot refund through the generic route any more than through the admin one.

**Guards**: the last super admin can never be demoted or removed (checked under an advisory lock in
`admin_set_team_member()`/`admin_remove_team_member()`); nobody can remove or suspend themselves;
only a super admin can suspend another admin.

**Privilege escalation closed.** Phase 1's `user_roles` INSERT/DELETE policies let *any* admin write
*any* role for *any* user through raw PostgREST — including `admin`. Both policies lost their admin
arm: an admin changes another person's roles only through the audited API.

**Known boundary (deliberate):** team roles restrict what an admin can *do* through the API, and
every admin write is service-role behind that API. *Reads* through raw PostgREST still follow the
existing `has_role(admin)` RLS arms, so any admin can read what any admin could read before.
Pushing team roles into every RLS policy is a separate, larger change.

## Platform settings

`GET /v1/admin/settings` (everyone) / `PATCH /v1/admin/settings` (super admin, audited as
`ADMIN_UPDATED_SETTINGS` with before/after values).

| Setting | Unit | Default | Effect |
|---|---|---|---|
| `platform_fee_bps` | basis points (1800 = 18%) | 0 | `fee = round(base × bps / 10000)` added to new bookings |
| `tax_bps` | basis points | 0 | `tax = round((base + fee) × bps / 10000)` added to new bookings |
| `unpaid_hold_minutes` | minutes (5–10080) or `null` | `null` (off) | see below |

Every booking keeps its own price snapshot, so a change never alters an existing booking. Values are
cached in memory for 30 s per server instance.

> **iOS note:** the app already decodes `platform_fee_minor_units`/`tax_minor_units` and shows them
> as rows in booking detail when non-zero, and its review screen already tells the booker that quoted
> prices are indicative and the final total is calculated by ProdBnb. What it does not do yet is add
> the fee/tax to that pre-booking estimate — so with a fee or tax set, the estimate is lower than the
> total the booker is then asked to pay. Worth an iOS update before turning a fee on.

## Unpaid-hold expiry

A booking reserves its slot the moment it's created, paid or not, and since Phase 29.14-D hosts
don't see unpaid bookings — so an abandoned checkout used to block a host's calendar forever,
invisibly. With `unpaid_hold_minutes = N`, `expire_unpaid_bookings()` cancels a booking when **all**
of these hold:

1. status is `requested` or `confirmed`;
2. it was created more than N minutes ago;
3. it has no settled payment;
4. it has no payment attempt that could still succeed — an in-flight attempt protects the booking
   until its provider order expires (`payments.expires_at`).

When expiry is on, each new Cashfree order is created with `order_expiry_time` = the later of the
hold deadline and now + 16 min (Cashfree's minimum is 15), and that time is stored as
`payments.expires_at`. A checkout therefore always outlives the hold; the hold never ends under a
booker who is mid-payment.

Expiry sets `status = cancelled`, `hold_expired_at = now()`, `cancelled_by = null`, and writes an
in-app `booking_cancelled` notification for the booker (`data.reason = "unpaid_hold_expired"`). No
push is sent (Postgres can't make HTTPS calls); the in-app record is always written.

It runs every minute through pg_cron (when available on the project — the migration is guarded) and
lazily, scoped to one listing, right before the backend computes availability or creates a booking,
so correctness never depends on cron timing.

A payment that still settles on an expired booking (e.g. a very late webhook) shows up in
`GET /v1/admin/payments/attention` together with every other "money taken, booking not happening"
case.

## Dispute message access

- `GET /v1/admin/conversations?booker_id=&host_id=&location_id=&booking_id=` — **metadata only**:
  participants, listing, booking, message count, timestamps. Never a body or preview.
- `POST /v1/admin/conversations/:id/access` `{ reason }` (≥ 10 characters) — writes an
  `admin_message_access` row **first**, then returns the transcript (newest 1000 messages). No
  record, no messages.
- `GET /v1/admin/message-access-log` — every such read, with its reason. Append-only; no admin can
  write, edit or erase it.

Permission: `messages.access` (super admin, support). Participant RLS still has no admin arm.

## Other operations

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /v1/admin/me` | any admin | team role + permissions |
| `GET/POST /v1/admin/team`, `PUT/DELETE /v1/admin/team/:userId` | read: all; write: team.manage | add by email (account must exist) |
| `POST/DELETE /v1/admin/users/:id/roles/:role` | users.manage | booker/host only; audited |
| `PATCH /v1/admin/locations/:id` | locations.moderate | content only (never status); audited with field names |
| `GET /v1/admin/locations/:id/gallery` | locations.view | general gallery + every section's |
| `POST /v1/admin/locations/:id/media/:mediaId/remove` | locations.moderate | deletes the R2 object; audited |
| `POST /v1/admin/locations/:id/sections/:sectionId/remove` | locations.moderate | empty sections only; audited |
| `GET/POST /v1/admin/catalog/:kind`, `PATCH/DELETE …/:itemId` | read: locations.view; write: catalog.manage | delete refused (409) while any listing uses it |
| `POST /v1/admin/bookings/:id/confirm\|reject\|complete` | bookings.manage | thin wrappers, audited |
| `GET /v1/admin/bookings?payment_state=paid\|unpaid\|unpaid_hold` | bookings.view | `unpaid_hold` = unpaid and still holding its slot; admin rows add `hold_expires_at` |
| `POST /v1/admin/payments/:id/verify` | payments.verify | re-asks Cashfree; audited |
| `GET /v1/admin/payments/attention` | payments.view | settled payment + cancelled/rejected booking, not fully refunded |
| `GET /v1/admin/analytics?from=&to=&bucket=&tz=` | analytics.view | one SQL function, India time by default |
| `GET /v1/admin/system/integrations?check=true` | system.view | see below |

Admin edits to someone else's listing are audited on the shared routes too
(`ADMIN_UPDATED_LOCATION`, `ADMIN_DELETED_MEDIA`, `ADMIN_DELETED_SECTION`), so the route an admin
uses never decides whether the action leaves a trail.

## Integrations & secrets status

The decision for this feature: **status only — secret values never leave Vercel.**
`GET /v1/admin/system/integrations` lists every key per integration (Supabase, R2, Cashfree,
payment webhooks, APNs, platform rules) as:

- `secret` — set or missing, nothing else;
- `identifier` — set, plus the last 4 characters (to tell two keys apart);
- `public` — the value (URLs, bucket name, environment names).

`?check=true` runs live checks without changing anything: both Supabase keys can query; R2
`HeadBucket`; Cashfree looks up an order id that can't exist (404 = credentials accepted,
401/403 = rejected); APNs signs a provider token with the configured key; the webhook check reports
when one was last received and flags a localhost/non-HTTPS `API_BASE_URL`. Editing happens in
Vercel's environment-variable settings; the Admin Panel links there.

## Grant hardening

Supabase's default privileges grant **every** privilege (including TRUNCATE, which RLS does not
cover) on every new `public` table to `anon` and `authenticated`, so each migration's own
`grant select …` was additive rather than the whole truth. RLS was what actually refused writes,
silently (zero-row no-ops), and the grant layer provided none of the defence in depth the earlier
docs describe. `20261115090000_grant_hardening.sql` revokes everything from both client roles on
every table and grants back exactly what the earlier migrations intended, table- and column-level.

Verified locally: the full suite (1003 tests) passes, including 15 tests that expected
`permission denied` and previously failed against a fresh Supabase stack.

---

# Admin Console 2

Migrations `20261115140000` … `20261115180000`. All new admin routes live in
`src/modules/admin/console2.routes.ts` (mounted inside the admin router, so every one is admin-gated
and names its permission). Every write is audited (`admin_audit_log`, vocabulary widened in
`20261115140000_admin_console_2_audit_vocabulary.sql`).

## Listings created for a host

`POST /v1/admin/locations` takes the host's own create body plus `host_id`, `grant_host_role` and
`status` (`draft` | `published`). The listing belongs to the host from the start (`host_id` is
theirs; they manage it in their app). A non-host is refused unless `grant_host_role: true`, which
grants the role in the same step (audited as `ADMIN_GRANTED_ROLE`). `GET /v1/admin/hosts/search`
finds people by name or email (`admin_search_users()`, which reads `auth.users`).

**Full editing needs no new route.** Photos (upload / reorder / cover = first photo / delete),
pricing, opening hours, date exceptions, blocks and sections are edited through the same shared
endpoints a host uses (`/v1/locations/:id/...`), which already accept an admin with
`locations.moderate`. Those writes are now audited when the admin is not the owner
(`auditAdminListingEdit`: `ADMIN_UPLOADED_MEDIA`, `ADMIN_REORDERED_MEDIA`, `ADMIN_UPDATED_PRICING`,
`ADMIN_UPDATED_AVAILABILITY`, `ADMIN_UPDATED_SECTION`). Publishing a draft uses the shared
`PATCH /v1/locations/:id {status}` (audited as `ADMIN_UPDATED_LOCATION_STATUS`).

Admin list rows (`GET /v1/admin/locations`) now carry `cover_url`, `media_count`, `host` and
`starting_price`.

**Browser uploads need R2 CORS.** The Admin Console PUTs files straight to presigned R2 URLs. The
bucket must allow `PUT` from the console's origin. Integrations shows an "R2 browser uploads" check;
"Allow browser uploads" (`POST /v1/admin/system/r2-cors`) adds the rule for `CORS_ORIGINS`, keeping
existing rules. That needs an R2 token with bucket-admin scope; with an object-only token, add the
rule in the Cloudflare dashboard (R2 → bucket → Settings → CORS policy):

```json
[{ "AllowedOrigins": ["https://prodbnb-admin-staging.vercel.app"], "AllowedMethods": ["PUT", "GET", "HEAD"], "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]
```

## Catalog covers and collections

Categories, amenities and use cases gain `description` and a cover image (presign → browser PUT →
`PUT …/cover` verifies the object in R2 and that its key belongs to that item). Admins can tag and
untag listings per item. Public `GET /v1/categories` (etc.) adds `description` + `cover_url`.

Collections (`collections`, `collection_locations`) are curated, ordered sets of listings with a
cover and a publish toggle. Public: `GET /v1/collections`, `GET /v1/collections/:idOrSlug` — RLS
returns only published collections and only published listings inside them.

## Messaging: channels, announcements, direct notifications

**Channels** (`messaging_channels`): SMTP, APNs, FCM, Web Push. Non-secret settings in `config`; the
secret (SMTP password, `.p8` key, service-account private key, VAPID private key) in **Supabase
Vault**, written by `messaging_channel_save()` and read only by `messaging_channel_secret()` —
both service-role only. No API response, log line or audit entry contains a secret; a blank secret
on save keeps the stored one. Credentials are cached in memory for 60 s.

**Push routing is per device platform** (`notifications/providers/index.ts`): iOS → APNs (the
dashboard key if connected, else the original `APNS_*` env vars when `NOTIFICATION_PROVIDER=apns`),
Android → FCM HTTP v1, web → Web Push (VAPID). A platform without a provider records an honest
`skipped` attempt. Devices may now register as `android` or `web` (web needs `web_push_keys`), and
may report `app_version`.

**Campaigns** (`notification_campaigns`, `campaign_recipients`): one message over any mix of
in-app / push / email, to everyone, a role, everyone with the app on chosen platforms, or chosen
people. Push implies an in-app record. Lifecycle draft → (scheduled →) sending → sent | cancelled.
The audience is expanded once in SQL; recipients are processed in leased batches (`skip locked`,
5-minute lease) — inline for ~8 s after Send, while the campaign page is open, and every minute by
pg_cron → pg_net → `POST /v1/internal/jobs/dispatch` (shared secret in Vault) once **Delivery
engine** is enabled with the backend URL. Email is throttled to the SMTP channel's
`max_per_minute`.

**Old iOS builds are protected.** The iOS app in the field rejects its whole notifications list on
an unknown type, so `announcement` notifications are only listed for clients that send
`X-ProdBnb-Capabilities: announcements`. Push still reaches them. Users can opt out of announcement
pushes (`notification_preferences.announcement`).

**Email**: bodies are plain text with `**bold**`, `[link](https://…)` and paragraphs, everything
else escaped. Announcement emails carry a signed one-click unsubscribe (RFC 8058,
`List-Unsubscribe-Post`); `GET /v1/email/unsubscribe` only shows a confirm button, `POST` records
the suppression. Direct messages ignore suppressions and carry no unsubscribe link.

## Platform release control

`app_platforms` (ios / android / web: status, live / latest / minimum version, store URL, update
messages, maintenance mode), `feature_flags` (per-platform on/off + optional minimum version),
`platform_incidents` (+ timeline), `release_plans` (promote-to-live sets the platform's live and
latest version), `client_version_activity` (which versions signed-in clients run; pruned after 90
days).

Apps read one thing: **`GET /v1/app-config?platform=ios&version=1.4.2`** →
`{ status, maintenance, update: { required, available, latest_version, min_supported_version,
store_url, message }, features: { key: bool }, incidents: [...] }` (+ `web_push_public_key` for
web). Public, cacheable for 30 s. Clients that send `X-ProdBnb-Platform` and
`X-ProdBnb-App-Version` while signed in are counted in "Versions in use". Wiring the iOS app to
these headers and to `/v1/app-config` is part of the next iOS release.

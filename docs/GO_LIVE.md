# Going live

**Status (19 Nov 2026):** production is set up but switched off. Launch waits until the iOS and
Android apps are final. Until then all work and testing happens on **staging**.

## The two environments

| | Production (`main` branch) | Staging (`staging` branch, and every preview) |
|---|---|---|
| Database | Supabase `heken-production` (`rvnfqqljzjofknyopfyy`, Mumbai), empty | Supabase `heken-staging` (`yspyemtiepgcoovjrgin`, Singapore) |
| Website | https://heken.co (www redirects) | https://staging.heken.co |
| Admin | https://admin.heken.co | https://admin-staging.heken.co |
| API | https://api.heken.co | https://api-staging.heken.co |
| Photos | R2 `heken-media` at https://media.heken.co | R2 `prodbnb-media-staging` at https://media-staging.heken.co |
| Payments | Cashfree sandbox (production keys come later) | Cashfree sandbox |
| Search engines | Hidden until `SITE_INDEXABLE=true` | Always hidden |
| Who can open it | Everyone, once DNS is added | Website and API: anyone (the website is never indexed). Admin: needs a Vercel login |

All three Vercel projects (`prodbnb-backend-staging`, `prodbnb-web-staging`, `prodbnb-admin-staging`)
hold both sets of settings: **Production** values for `main`, **Preview** values for `staging`.
The API runs in Mumbai (`bom1`); the website and admin too.

## Until launch

- **Don't merge into `main` and don't redeploy production in Vercel.** Three production keys are
  deliberately missing (below), so a production backend build would not start. The old
  `prodbnb-*-staging.vercel.app` addresses still serve the pre-split build on the staging database.
- Normal flow: working branch → `staging` (deploys to the staging addresses) → test there.

## Go-live steps, in order

1. **Production keys** (Vercel → `prodbnb-backend-staging` → Settings → Environment Variables,
   Environment = Production, Sensitive):
   - `SUPABASE_SERVICE_ROLE_KEY`: Supabase → heken-production → Project Settings → API Keys → Legacy → `service_role`
   - `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`: Cloudflare R2 API token for `heken-media` (Object Read & Write)
2. **DNS** (Cloudflare → heken.co → DNS, Proxy status = DNS only):

   | Type | Name | Content |
   |---|---|---|
   | A | @ | 216.198.79.1 |
   | A | @ | 64.29.17.1 |
   | CNAME | www | 10a2afe39b92d7ba.vercel-dns-017.com |
   | CNAME | admin | 99d1169bc0c71782.vercel-dns-017.com |
   | CNAME | api | bc1154574ad4acd3.vercel-dns-017.com |

3. **Photo uploads to `heken-media`** (Cloudflare → R2 → heken-media → Settings → CORS Policy):
   ```json
   [{"AllowedOrigins":["https://heken.co","https://www.heken.co","https://admin.heken.co"],"AllowedMethods":["PUT","GET","HEAD"],"AllowedHeaders":["content-type"],"MaxAgeSeconds":3600}]
   ```
4. **Vercel Pro** for the team: the Hobby plan is for non-commercial use only.
5. **Deploy:** merge `staging` into `main` for the backend, website and admin, and deploy in that
   order (the website build reads from the API). Run the checklist in `docs/PRODUCTION_RUNBOOK.md`.
6. **Supabase Auth → URL Configuration** (heken-production): Site URL `https://heken.co`; Redirect
   URLs `https://heken.co/**`, `https://admin.heken.co/**`.
7. **First admin:** sign up on heken.co, then grant the admin role to that account by SQL.
8. **Production admin settings** (stored per database, so staging's don't carry over): Google Maps
   key and Map ID, email (SMTP) and push channels, Vercel token, platform fee and tax, and the
   background jobs dispatcher (Messaging → URL `https://api.heken.co/v1/internal/jobs/dispatch`).
9. **Supabase Auth SMTP** on heken-production (the built-in mailer sends only a few emails an hour).
10. **Google / Apple sign-in** for production: add `https://rvnfqqljzjofknyopfyy.supabase.co/auth/v1/callback`
    to the providers and enable them in heken-production.
11. **Apps:** release builds use `https://api.heken.co/v1` with the heken-production Supabase URL and key.
12. **Search engines:** set `SITE_INDEXABLE=true` for Production on the website project and redeploy.
13. **Later:** Cashfree production keys (code change: `CASHFREE_ENV` only accepts `test` today),
    APNs production gateway (`APNS_ENVIRONMENT` only accepts `sandbox`), Supabase Pro and
    leaked-password protection.

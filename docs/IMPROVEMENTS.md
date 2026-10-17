# What changed (humanizer, copy tokens, reliability)

## One-time setup
1. In the Supabase SQL editor: `db/migration_humanize.sql` (profile requests) and `db/migration_shop.sql` (shop).
2. `npm install && npm run build:js` — `src/app.js` / `src/redeem.js` changed.
   On Vercel this now happens by itself: `package.json` has a `vercel-build` script.
3. Vercel only: call `GET /api/cron/sync` every minute (external pinger, `CRON_SECRET`). The built-in timer
   does not exist on serverless; without it, boosts of customers who closed their page, direct SellAuth
   boosts, the low-balance alert and the profile jobs only advance when someone opens the admin panel.
   (Vercel's own cron every minute needs a paid plan, so it is not put in `vercel.json`.)

## Features
- **Account profile (Salta7 humanizer)** on the redeem pages — see `HUMANIZER.md`.
  Admin: Settings → *Account profile* (on/off + your own name / bio lists for "Random").
- **Copy tokens**: *Copy unused* / *Copy all* in the admin Stock tab and the reseller Files tab
  (every token, read page by page — Supabase caps a request at 1000 rows).
- **Stock list**: search by the start of a token, filter used / unused, 100 per page (admin + reseller).
- **Job driver** (`services/jobDriver.js`): besides direct SellAuth boosts it now also drives any running
  job whose customer page went quiet for 45 s (retries, finishing, reseller billing, profile job).
- **Salta7 balance**: shown on the admin Overview; Discord alert when it falls below a threshold
  (Settings → Discord alerts, event *Low Salta7 balance*, default $5, one message per 6 h).
  Assumes `GET /balance` answers with a `balance` (or `amount` / `credits`) number.
- **Tracking link**: after a redeem the customer gets `/status/<job id>` (copy button) that shows the
  progress even after closing the page. It works for key redeems now, not only direct SellAuth orders.
- **Key guessing guard**: 12 redeem attempts / minute / IP, and 8 wrong keys = 15 min lock-out for that IP
  (in memory per server instance; keys are 16 random characters anyway).

- **Discord admin bot**: `/stock /restock /genkey /boost /job /jobs /key /revoke /balance` — see `DISCORD_BOT.md`.

- **Shop** (`/shop`): premium + credit packs, paid from the wallet or in Litecoin, with an admin tab to edit packs and see
  orders — see `SHOP.md` (needs `db/migration_shop.sql`).

## Already there (not changed)
- Reseller statistics (per-day charts, sources, top servers, failures) — Stats tab.
- A reseller's own Discord webhook for finished / failed boosts and low stock — Settings tab.

## Not done
- Encrypting tokens in the database: every part of the app that reads, deduplicates (`token` is unique),
  checks, joins or exports a token would have to change at once, plus a migration of existing rows.
  Doing that without a test database is too risky; protect the database instead (Supabase service key
  only on the server, RLS on, no public access).

# Admin panel

Open `/admin`, sign in with the admin account, then the panel password.

## What the admin can see and do

| Page | What's in it |
| --- | --- |
| **Overview** | Stock coverage, boosts per day, **accounts, wallet totals, deposits received, 30-day success rate, new accounts per day, deposits per day, top resellers, most boosted servers**. |
| **Keys / Stock / Jobs** | As before. Jobs can be filtered (running / completed / failed), every job has a **detail page** (provider id, masked tokens, retries, who/what) and every list exports to **CSV**. |
| **Users** | Search + filter (boosters / resellers / admins), CSV export, open any account. |
| **Account sheet** (`#/user/<id>`) | Everything about one account: wallet, jobs, deposits, private note. Actions: add/remove funds, **reset password**, **suspend / reactivate**, make/disable reseller, price per boost, revoke API key, delete. |
| **…for a reseller** | Also: their **redeem page** (edit name, title, header name, colour, support link, remove icon, unpublish), **their keys** (list, copy, **generate keys for them**, delete unused / all, CSV), stock counts, SellAuth deliveries. |
| **Resellers** | Table of resellers with a *Manage* button to their sheet. |
| **Deposits** | Every wallet top-up with status filter, totals, CSV. |
| **Activity** | Log of every change made from the panel (who, what, result). Passwords, tokens and keys are never stored in it. |
| **System** | Runtime info, which settings are configured (values never shown), which SQL migrations are applied, row counts per table. |
| **Search box** (top bar, press `/`) | Finds accounts, redeem pages, keys and jobs from anywhere. |

## One migration to run

`db/migration_admin_tools.sql` (Supabase → SQL Editor → Run). It adds:

- `users.disabled` — suspended accounts cannot sign in; existing sessions are refused too.
- `users.admin_note` — the private note.
- `admin_audit` — the activity log.

Until it has run, everything else keeps working (nobody is locked out); only suspension, notes and the
activity log show a message telling you which file to run. The **System** page shows what is missing.

Suspending only blocks sign-in. To also stop a reseller's keys and redeem page, disable reseller access.


## Link embed (the card shown when a link is pasted in Discord, Telegram, X…)

- **Main site** — *Settings → Link embed — main site*: site name, title, description, stripe colour and image
  (upload or an https link), with a live preview. Empty fields fall back to the defaults.
- **A reseller's page** — the reseller edits it themselves in *Redeem Page → Link embed*; you can also edit it
  (or remove its image) from their account sheet. Without a custom image the page icon is used.
- Link crawlers don't run JavaScript, so the tags are written into the HTML by the server. Images are served from
  `/embed/site` and `/embed/r/<name>` (with a version in the URL, so a new image refreshes).
- Discord/Telegram cache previews: a changed card can take a few minutes to show up for links already pasted.
- Reseller embeds need `db/migration_embed.sql` (the **System** page shows if it is missing). The main-site embed needs nothing.

## Scrolling

On desktop the menu and top bar stay in place and only the selected page scrolls (admin panel and customer /
reseller dashboard). On phones the normal page scroll is kept (fixed tab bar / drawer menu).


## SellAuth direct delivery

*SellAuth → On each order* chooses between boosting the buyer's server directly (default) or sending a key.
Direct boosts need the job driver: automatic on always-on hosting; on Vercel set `CRON_SECRET` and ping
`/api/cron/sync` every minute. See `docs/SELLAUTH_DIRECT.md`.


## Discord alerts & order status page

*Settings → Discord alerts* (webhook URL, which events, low-stock threshold, test button) and the public page
`/status/<order id>` linked in the buyer's SellAuth message. See `docs/ALERTS_AND_STATUS.md`.

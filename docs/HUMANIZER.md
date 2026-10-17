# Humanizer (account profile)

On the redeem pages (the main panel's redeem tab and the `/r/<name>` reseller page) the
customer can optionally give the boosting accounts a **picture, name and bio**, through the
Salta7 `humanize` tool.

## Setup (once)
1. Run `db/migration_humanize.sql` in the Supabase SQL editor.
2. Rebuild the obfuscated bundles: `npm install && npm run build:js`
   (`src/app.js` and `src/redeem.js` changed; `public/humanizer.js` is plain and shared).

## How it works
- The card is injected by `public/humanizer.js` inside the REDEEM KEY section.
- `POST /api/boost/redeem` accepts an optional `humanize` object, validated by
  `services/humanizer.js` (name <= 32, bio <= 190, avatar = png/jpeg/webp/gif data URL):
  `{ avatar?, name?, bio? }`, each `{ "source": "random" }` or `{ "source": "custom", "value": ... }`.
- The request is stored in `job_humanize`. When the boost job is finalized, ONE Salta7
  `humanize` job (`tool: humanize`, `mode: byot`) is started for the accounts that joined.
- `GET /api/boost/redeem/status/:id` returns a `humanize` state (`pending`, `running`,
  `completed`, `partial`, `failed`, `skipped`) which the result page shows and polls.
- Best-effort: a humanize problem never affects the boost, the key or reseller billing.

## Cost
Billed by Salta7 on the master token's balance. In BYOT mode, accounts bought from Salta7 get
one free humanize every 24h; others are charged the `humanize_price` (see `/task/byot/quote`).
A custom value is the same on every account; "Random" picks a different one per account.

## Admin settings
Settings → *Account profile*: switch the option off (the card disappears from the redeem pages), and give
your own lists of names / bios. When a customer picks "Random", each group of accounts (at most 25 groups,
so up to 25 Salta7 jobs) gets a different line from your lists; an empty list uses Salta7's own library.
The ids of those Salta7 jobs are stored comma-separated in `job_humanize.salta7_job_id`.

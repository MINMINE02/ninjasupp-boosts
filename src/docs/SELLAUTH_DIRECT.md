# SellAuth — direct boost delivery

With **Dynamic Delivery**, an order can now boost the buyer's server **immediately**, using the invite they
typed in the **Server Link** custom field. No key is handed out.

## How it works

1. The buyer orders and pastes their Discord invite in the product's custom field.
2. SellAuth calls your webhook. The server reads the invite, takes the stock tokens, starts the boost.
3. The buyer receives one line: `Boost started: 14 boosts on discord.gg/xxxx — it is applied within a few minutes. Track it live: https://YOUR-DOMAIN/status/<order id>` (a public progress page, see `ALERTS_AND_STATUS.md`).

A paying customer is never left with nothing. A **key is delivered instead** (the old behaviour) when:

| Situation | What happens |
| --- | --- |
| the custom field is empty or isn't an invite | key delivered, reason logged |
| not enough stock tokens | key delivered (redeemable later once stock is back), reason logged |
| the reseller is out of credit | key delivered, reason logged |
| the boost provider is down | key delivered, tokens and key released, reason logged |

The reason shows in the **Deliveries** table (admin and reseller).

## Choosing the mode

- **Default: direct.** Change it in *SellAuth → On each order* (admin) or in the reseller's SellAuth card.
- **Per product**, in the webhook URL: `…/api/sellauth/deliver?mode=key` (or `?mode=direct`). It beats the default.
- Amount of boosts: unchanged (`?boosts=14`, product link, “14 Boosts” in the name, fallback).

## Safe against SellAuth retries

SellAuth retries when a call times out. The delivery is locked while the boost starts, so a retry
(or two identical calls at once) never starts a second boost: it gets the same answer, or a short
“in progress, retry shortly” (HTTP 503). If the server crashed in the middle, the next retry finishes
the bookkeeping without boosting twice.

## ⚠ Keep the boosts moving (important on Vercel)

A normal key is followed by the customer's page, which polls the job (that is what retries failed tokens,
finishes the job and bills a reseller). A direct delivery has no customer watching, so the **server** does it:

- **VPS / Railway / Render (always-on Node)**: automatic, every 20 seconds. Nothing to do.
- **Vercel (serverless, no timers)**: set the environment variable `CRON_SECRET` to a long random string and
  call this URL **every minute** with a free pinger (cron-job.org, UptimeRobot…):

  `https://YOUR-DOMAIN/api/cron/sync?secret=YOUR_CRON_SECRET`

  (or send the header `Authorization: Bearer YOUR_CRON_SECRET`). Vercel's own Cron works too if your plan allows
  one-minute schedules — don't add a `crons` entry on a Hobby plan, the deploy would be refused.
- Opening the admin **SellAuth** page also advances them.

The admin SellAuth page warns you when it detects serverless hosting without `CRON_SECRET`.

## What the admin / reseller sees

*Deliveries* show a **boosted directly** tag, the server, and the live job status (`running 6/14`, `completed 14/14`,
`failed`) — the admin also gets a link to the job. Internal keys of direct boosts have the source `sellauth-direct`
in the Keys list.

## Migration (optional)

`db/migration_sellauth_direct.sql` adds the reseller's own mode setting. Without it everything works and
resellers are in direct mode; they can still pick per product with `?mode=key`. The **System** page shows if it's missing.

## If a direct boost fails after it started

If the provider ultimately fails (job `failed`), the buyer has no key. Check the job in the admin panel,
and send a key from *Keys* / the reseller's account sheet (or refund) — the delivery log shows the invoice id.

# Discord alerts & live order status

## 1. Discord alerts

The panel posts to a Discord channel (a webhook) when something happens.

**Set up (once):**
1. In Discord: channel settings → *Integrations* → *Webhooks* → *New webhook* → *Copy Webhook URL*.
2. Admin panel → *Settings → Discord alerts* → paste the URL → *Save* → *Send test message*.

**What you get** (each one can be switched off):

| Alert | When |
| --- | --- |
| 🚀 / 🔑 **New orders** | a SellAuth order came in — boosted directly, or a key delivered (with the reason when it fell back) |
| ✅ **Boost completed** | a boost finished (all boosts delivered) |
| ❌ **Boost failed** | a boost ended incomplete. For a direct order it tells you to send a new key or refund |
| ⚠️ **Low stock** | a pool (the platform's, or a reseller's) drops below the threshold you choose (default 20). One alert per pool every 6 h, re-armed once stock is healthy again |

Every alert says which seller it concerns (*Platform* or the reseller's name). Alerts about finished / failed boosts
link to the job in your admin panel.

Safe by design:
- The webhook URL is a secret: it is stored, never shown again (only its last 6 characters), and only real
  `discord.com/api/webhooks/…` addresses are accepted.
- `@everyone` and mentions inside order data can't ping anyone.
- An alert problem **never breaks an order**: if Discord is down or slow (2.5 s timeout) the order is delivered anyway.

Optional: set `PUBLIC_URL` (e.g. `https://yourdomain.com`) if links in alerts should use a fixed address; otherwise the
address your site is visited on is used.

## 2. Live order status page

The buyer's message now ends with a link:

`Boost started: 14 boosts on discord.gg/xxxx — it is applied within a few minutes. Track it live: https://YOUR-DOMAIN/status/<order id>`

The page shows the progress ring (6/14 → 14/14), the server, and a clear result. If something is incomplete it offers a
**Contact support** button — the **seller's** support link (a reseller's own link; never the platform's for a reseller order).
For a reseller's order the page is shown in that reseller's colour, icon and name.

- Public and read-only: no login, no key, nothing about accounts. The link contains a random order id.
- Only direct SellAuth orders have a status page. Unknown or normal-key orders show "Order not found".
- It refreshes by itself every few seconds. The data moves forward as fast as the job driver (every 20 s on an always-on
  host, every minute with the cron pinger on Vercel — see `SELLAUTH_DIRECT.md`).

## Also fixed: a job can only be finalised once

Finishing a boost bills the reseller and credits the key. Several things can look at a job at once (the customer's page,
a second tab, the server-side driver), so finalising is now atomic: exactly one of them does it, the others just read the
result. This also guarantees one single Discord alert per job.

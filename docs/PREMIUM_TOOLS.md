# Premium tools: personal Discord alerts · Stats · Custom domain

Needs `db/migration_premium_tools.sql` (Supabase → SQL Editor → Run). Without it everything else keeps working; these
options just show "temporarily unavailable". The admin **System** page tells you if it is missing.

## 1. Personal Discord alerts (premium dashboard → API tab)

Each premium account can paste **its own** Discord webhook and gets, in its own channel:
new orders · finished boosts · failed boosts · low stock (its own threshold, default 20).

- It only receives **its own** activity. It never gets another account's data, and never an admin link.
- The admin keeps receiving everything on his own webhook (Settings → Discord alerts), with the seller's name.
- The webhook URL is a secret: stored, never shown again (only its last 6 characters). Only real
  `discord.com/api/webhooks/…` addresses are accepted.
- Every alert is best-effort: if Discord is down, orders are still delivered.
- A "Send test message" button (limited to one every 10 s).

## 2. Stats (premium dashboard → Stats tab)

Last 7 / 30 / 90 days, this account's own numbers only: boosts delivered and orders (with the change versus the
previous period), success rate, money spent, boosts and orders per day (charts, hover for the exact value), where
orders come from (SellAuth direct / SellAuth key / keys redeemed on the page / own tokens), most boosted servers,
recent failures, tokens and keys left.

## 3. Custom domain (premium dashboard → Redeem Page tab)

A premium account can show its redeem page on **its own address** (`boost.theirshop.com`) instead of `/r/name`.

**What the account does** (the card walks them through it):
1. Enters the domain and presses *Add domain*.
2. Adds a **TXT** record `_ninja-verify.<domain>` with the value shown — this proves the domain is theirs.
3. Adds a **CNAME** (subdomain) or **A** record (bare domain) pointing at you.
4. Presses *Check now* until it says **live**.

**Why the TXT proof exists:** without it anybody could "claim" your main domain and make it show their page.
A domain only serves a page after its owner proved control of its DNS, and your own domains (the address you
use, `PUBLIC_URL`, `PRIMARY_DOMAINS`, `*.vercel.app`) can never be claimed.

**What a custom domain serves — and nothing else:** the account's redeem page, the order status page of *its own*
orders, and the few assets/APIs they need. `/admin`, the login, the dashboard, the other APIs and every other
account's page answer 404 there. `/r/name` redirects to `/`. Link previews (Discord…) use the custom domain.
Any other address (including your own main domain) behaves exactly as before — no configuration needed.

### Settings (all optional)

| Variable | What for |
| --- | --- |
| `CUSTOM_DOMAIN_TARGET` | The DNS name accounts point their CNAME at. **Recommended:** create e.g. `domains.yourdomain.com` → CNAME → `cname.vercel-dns.com` yourself, and set this to `domains.yourdomain.com`. Accounts never see the name of your hosting provider. (Default: `cname.vercel-dns.com`.) |
| `CUSTOM_DOMAIN_IP` | IP for bare domains (A record). Default `76.76.21.21`. |
| `PRIMARY_DOMAINS` | Your own domains, comma separated (extra protection: they can never be claimed). |
| `VERCEL_API_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` | **Automatic mode** on Vercel: once ownership is proven the domain is attached to your project (HTTPS certificate included). `VERCEL_TEAM_ID` only if the project belongs to a team. Create the token in Vercel → Account → Tokens. |

**Without the Vercel variables (manual mode):** the DNS check still works, but Vercel only serves domains attached
to your project, so you add each verified domain yourself in *Vercel → your project → Settings → Domains*. The admin
account sheet shows the state of every domain and a "Check DNS & hosting" button (with the real hosting answer —
accounts only ever see a neutral "we are finishing the setup" message).

Not on Vercel? The routing works on any host that forwards the visitor's `Host` header to the app; you then
add the domain to your own reverse proxy / certificate setup.

One domain per account. Removing it detaches it from the project (automatic mode).

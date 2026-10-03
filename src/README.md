# Ninja Boost

A Discord server boosting platform: a Node.js/Express backend backed by
Supabase, with a vanilla JS frontend, integrating the **Salta7** external API.
Dark UI: black + red accent, sidebar dashboard layout.

Two ways to boost, toggled from the header:

- **Key Redeem** (anonymous) — enter a 16-character key + a server invite; the
  platform boosts for you, drawing tokens from an admin-managed stock pool.
- **Booster / BYOT** (login) — register, top up a wallet, paste your **own**
  Discord tokens + invite, and pay only for captchas that actually get solved.

## Features

- **Public key redeem** — anonymous "key + invite → boost" flow with a live
  status ring and per-token results. Tokens are drawn from the admin stock pool.
- **BYOT boosting** — logged-in users boost with their own tokens; a live
  per-token status list (joined / failed / captcha / +boosts) and incremental
  wallet billing at the admin-set solve price.
- **Wallet + Litecoin deposits** — self-serve top-ups via **Tatum** (each gets a
  unique deposit address; funds are credited and swept to a main address), or
  admins credit balances by hand.
- **Admin panel** at `/admin` (admin login + `ADMIN_PANEL_PASSWORD`, enforced by the server with a signed 8 h panel token):
  - **Overview** — key / stock / job KPIs, 14-day boost chart, and a *stock coverage* gauge (can the stock honour every unused key?).
  - **Keys** — bulk generate with a note, filter (unused / redeemed / SellAuth), search, export unused, bulk delete.
  - **Stock** — add tokens, **token checker**, edit the unused pool as text, per-token copy / delete.
  - **Jobs** — live list of every boost job (key + BYOT).
  - **Users** — wallet credit / debit, make reseller, delete accounts.
  - **Resellers** — stock / keys / volume per reseller, price per boost, revoke API key, disable.
  - **SellAuth** — webhook URL + secret, product → boosts links, delivery log.
  - **Settings** — solve price, support link, admin credentials.
- **Resellers** — customers you switch on get their **own stock, keys, API key and redeem page** (`/r/<name>`),
  fully isolated from your pool, with optional per-boost billing. Includes a **Joiner**, a **Token checker** and **their own SellAuth dynamic delivery**. Admin: **Resellers** section. See [`docs/RESELLERS.md`](docs/RESELLERS.md).
- **SellAuth dynamic delivery** — `POST /api/sellauth/deliver` returns a fresh key per order item, signature-checked and idempotent. See [`docs/SELLAUTH.md`](docs/SELLAUTH.md).
- **Configurable logo link** — clicking the logo opens the URL from `LOGO_URL`.
- **Salta7 integration** — a dedicated `Salta7Service` wraps the boost endpoints.

## Stack

| Layer     | Tech                                            |
| --------- | ----------------------------------------------- |
| Backend   | Node.js, Express                                |
| Database  | Supabase (PostgreSQL) via `@supabase/supabase-js` |
| Auth      | JWT + bcrypt (admin + BYOT user accounts)        |
| External  | Salta7 API (boosting) · Tatum API (Litecoin)     |
| Frontend  | Static HTML/CSS/JS (served by Express)          |

## Project structure

```
.
├── server.js                # Express app + admin bootstrap
├── config/supabase.js       # Supabase service-role client
├── services/salta7.js       # Salta7Service (boost endpoints)
├── services/config.js       # app_config key/value (support contact link)
├── middleware/auth.js       # JWT auth + admin guard
├── utils/helpers.js         # invite/token parsing, key generation
├── services/settings.js     # settings key/value (BYOT solve price)
├── services/tatum.js        # Litecoin wallet / deposits (Tatum API)
├── routes/
│   ├── auth.js              # register / login / me
│   ├── boost.js            # redeem (public) + BYOT quote / start / status / history
│   ├── admin.js            # keys / tokens / users / stats / jobs / SellAuth config / unlock
│   ├── sellauth.js         # SellAuth dynamic delivery webhook
│   ├── reseller.js         # reseller dashboard API (stock, keys, orders, API key, page)
│   ├── v1.js               # public reseller API (API key)
│   ├── wallet.js           # balance + Litecoin deposits
│   ├── settings.js         # public pricing read
│   └── config.js           # public client config (logo + support link)
├── db/schema.sql            # Supabase tables
├── vercel.json              # runs server.js as one @vercel/node function
└── public/                  # index.html + styles.css + dashboard.css + app.js (customer panel)
                             # reseller.js + reseller.css (reseller pages of the customer panel)
                             # admin.html + admin.css + admin.js (admin panel, /admin)
```

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in:

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — from your Supabase project
  settings. The **service_role** key is required (server-side only).
- `SALTA7_MASTER_TOKEN` — your Salta7 master bearer token.
- `JWT_SECRET` — any long random string.
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — the bootstrap admin account, created on
  first launch.
- `ADMIN_PANEL_PASSWORD` — a second password that gates the admin dashboard
  (**required** — the server won't start without it).
- *(optional)* `TATUM_API_KEY` + `LTC_*` — only for self-serve Litecoin wallet
  top-ups. Without them, admins credit BYOT balances by hand.

> - **Every variable explained + where to get each value:**
>   [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md)
> - **Never deployed anything before? Step-by-step from zero:**
>   [`docs/DEPLOY_BEGINNER.md`](docs/DEPLOY_BEGINNER.md)

### 3. Provision the database

Open the Supabase SQL editor and run [`db/schema.sql`](db/schema.sql).

### 4. Run

```bash
npm start      # or: npm run dev  (auto-reload)
```

Visit <http://localhost:3000> to redeem a key, and <http://localhost:3000/admin> for the admin
panel (bootstrap admin account + `ADMIN_PANEL_PASSWORD`).

Editing the customer panel? Change `src/app.js`, then `npm run build:js` (regenerates the
obfuscated `public/app.js`). The admin panel (`public/admin.js`) is plain JS with no build step.

## Salta7 API mapping

`services/salta7.js` exposes:

| Method                          | Salta7 endpoint     |
| ------------------------------- | ------------------- |
| `getBalance(userToken)`         | `GET /balance`      |
| `createBoostJob(invite, tokens)`| `POST /task/create` |
| `getJobStatus(jobId)`           | `GET /task/status`  |
| `getJobItems(jobId)`            | `GET /task/items`   |

All requests are authenticated with the master token from `.env`.

## Backend API

| Method + path                        | Auth   | Purpose                              |
| ------------------------------------ | ------ | ------------------------------------ |
| `POST /api/boost/redeem`             | —      | Redeem a key + invite → start boost  |
| `GET  /api/boost/redeem/status/:id`  | —      | Poll an anonymous key job            |
| `GET  /api/boost/redeem/items/:id`   | —      | Per-token results of a key job       |
| `GET  /api/boost/invite-info`        | —      | Discord invite preview               |
| `POST /api/auth/login`               | —      | Admin login                          |
| `GET  /api/auth/me`                  | admin  | Current admin                        |
| `POST /api/admin/tokens`             | admin  | Restock stock tokens                 |
| `GET  /api/admin/tokens`             | admin  | List stock tokens (masked)           |
| `PUT  /api/admin/tokens/unused`      | admin  | Bulk edit the unused pool            |
| `DELETE /api/admin/tokens[/:id]`     | admin  | Delete all / one stock token         |
| `POST /api/admin/keys`               | admin  | Generate keys (bulk / per-key)       |
| `GET  /api/admin/keys`               | admin  | List keys                            |
| `DELETE /api/admin/keys[/:code]`     | admin  | Delete all / one key                 |
| `GET  /api/admin/settings`           | admin  | Read the price + support link        |
| `PATCH /api/admin/settings`          | admin  | Update the price + support link      |
| `GET  /api/config`                   | —      | Public client config (logo + support)|
| `POST /api/sellauth/deliver`         | HMAC   | SellAuth dynamic delivery → one key  |
| `GET  /api/sellauth/health`          | —      | Is the webhook secret configured?    |
| `POST /api/admin/unlock`             | admin  | Panel password → signed panel token  |
| `*    /api/reseller/*`               | login  | Reseller dashboard (enabled accounts)|
| `*    /api/v1/*`                     | API key| Public reseller API                  |
| `GET  /api/admin/resellers`          | admin+panel | Per-reseller stock / keys / volume |
| `GET  /api/admin/stats`              | admin+panel | Dashboard KPIs + 14-day series  |
| `GET  /api/admin/jobs`               | admin+panel | Latest boost jobs               |
| `*    /api/admin/sellauth/*`         | admin+panel | Webhook config, links, log      |

All `/api/admin/*` routes except `unlock` also require the `X-Panel-Token` header.

Keys are 16 characters (uppercase letters + digits). The single admin login is
the only gate on the dashboard.

## Notes

- The service-role Supabase key bypasses Row Level Security — keep it on the
  server and never ship it to the browser.
- The key redeem flow is anonymous: no account is involved. The only login is
  the admin account, used to restock tokens and manage keys.
- Set `MAINTENANCE_MODE=true` to serve the "Under Development" page for the
  whole site without a code change.

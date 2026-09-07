# Ninja Boost

A Discord server boosting platform: a Node.js/Express backend backed by
Supabase, with a vanilla JS frontend, integrating the **Salta7** external API.
Dark monochrome (grey / white) UI.

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
- **Admin dashboard** (admin login + a second `ADMIN_PANEL_PASSWORD` gate):
  - **Keys** — generate 16-character keys in bulk, each with its own boost amount.
  - **Tokens** — upload / bulk-edit / delete the stock token pool.
  - **Users** — list BYOT accounts, credit / debit wallet balances.
  - **Pricing** — the per-captcha solve price + the support contact link.
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
│   ├── admin.js            # keys / tokens / users / pricing / unlock
│   ├── wallet.js           # balance + Litecoin deposits
│   ├── settings.js         # public pricing read
│   └── config.js           # public client config (logo + support link)
├── db/schema.sql            # Supabase tables
├── vercel.json              # runs server.js as one @vercel/node function
└── public/                  # Frontend (index.html, styles.css, app.js)
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

Visit <http://localhost:3000> to redeem a key, or click **Admin** and sign in
with the bootstrap admin account.

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

Keys are 16 characters (uppercase letters + digits). The single admin login is
the only gate on the dashboard.

## Notes

- The service-role Supabase key bypasses Row Level Security — keep it on the
  server and never ship it to the browser.
- The key redeem flow is anonymous: no account is involved. The only login is
  the admin account, used to restock tokens and manage keys.
- Set `MAINTENANCE_MODE=true` to serve the "Under Development" page for the
  whole site without a code change.

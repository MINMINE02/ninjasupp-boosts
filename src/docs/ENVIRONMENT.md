# Ninja Boost — Environment setup

A complete walkthrough of every variable in [`.env.example`](../.env.example):
what it does and **where to get the value**.

```bash
cp .env.example .env      # then fill .env in
```

`.env` is in `.gitignore` — never commit it.

---

## Overview

| Variable | Required | Where it comes from |
| --- | --- | --- |
| `PORT` | no | you pick it (local port) |
| `NODE_ENV` | no | `development` or `production` |
| `MAINTENANCE_MODE` | no | you set it (`true` / leave unset) |
| `JWT_SECRET` | **yes** | you generate it (random string) |
| `JWT_EXPIRES_IN` | no | you pick it (e.g. `7d`) |
| `SUPABASE_URL` | **yes** | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | Supabase → Project Settings → API Keys |
| `SALTA7_BASE_URL` | no | fixed: `https://salta7.store` |
| `SALTA7_MASTER_TOKEN` | **yes** | your Salta7 account → dashboard / API |
| `BOOSTS_PER_TOKEN` | no | `2` (default) |
| `CAPTCHA_COST` | no | `0.015` (default) — the BYOT solve price |
| `ADMIN_USERNAME` | **yes** | you pick it |
| `ADMIN_PASSWORD` | **yes** | you pick it (strong!) |
| `ADMIN_PANEL_PASSWORD` | **yes** | you pick it (second admin gate) |
| `LOGO_URL` | no | your own URL, or empty |
| `TATUM_API_KEY` + `LTC_*` | no* | Tatum — needed only for BYOT Litecoin deposits |

\* Leave the whole Tatum block empty to ship without self-serve deposits — the
BYOT wallet then only fills up when an admin credits a balance by hand.

Minimum needed to boot: `JWT_SECRET`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SALTA7_MASTER_TOKEN`, `ADMIN_USERNAME`,
`ADMIN_PASSWORD`, `ADMIN_PANEL_PASSWORD`.

> **Two panels.** The public site has a header toggle:
> **Key Redeem** (anonymous — enter a key + invite) and **Booster** (BYOT —
> log in, paste your *own* tokens, pay per captcha from a wallet balance).
> The BYOT side is what needs users, the wallet, and — for self-serve top-ups —
> Tatum.

---

## 1. `PORT`

The port the local server listens on. Default `3000`.

```env
PORT=3000
```

Pick anything free. On Vercel this is ignored (the app runs serverless, with no
fixed port).

---

## 2. `NODE_ENV`

`development` locally, `production` in a live deployment. Only affects a few
internal Express defaults (caching, error output). Nothing to "obtain".

```env
NODE_ENV=production
```

---

## 3. `MAINTENANCE_MODE`

Commented out in `.env.example`. Set it to `true` and the whole site returns
`503` + the "Under Development" page
([`public/maintenance.html`](../public/maintenance.html)) — no code change
needed. Leave it unset (or anything other than `true`) to run normally.

```env
MAINTENANCE_MODE=true
```

---

## 4. `JWT_SECRET`  ⚠️ Required

Signs the admin session token (JWT). **The server refuses to start without it**,
and there is deliberately no fallback: a known secret means anyone can forge an
admin token.

**Generate your own** long random string (≥ 32 chars, more is better):

```bash
# Node (always available — this is a Node project)
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# or openssl (Linux / macOS / Git Bash)
openssl rand -hex 48

# or PowerShell
-join ((1..96) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
```

Copy the whole output:

```env
JWT_SECRET=3f9c1e7a...   (your generated value)
```

If you change this later, every existing admin login is invalidated (just log in
again). If you suspect it leaked, regenerate it.

Reference: <https://nodejs.org/api/crypto.html#cryptorandcombytessize-callback>

---

## 5. `JWT_EXPIRES_IN`

How long an admin login stays valid. Default `7d`. Uses the
[`ms`](https://github.com/vercel/ms) format from the `jsonwebtoken` library:
`60` (seconds), `10m`, `2h`, `7d`, `30d` …

```env
JWT_EXPIRES_IN=7d
```

---

## 6. `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`  ⚠️ Required

The database (Postgres) that stores keys, stock tokens, jobs and the admin
account.

### Step by step

1. Create an account at **<https://supabase.com>** (GitHub login works).
2. Dashboard → **New project**
   (<https://supabase.com/dashboard/projects>): pick an org, name it e.g.
   `ninja-boost`, choose a region close to your server, set a **Database Password**
   → *save it somewhere safe* (you don't need it here, but it can't be viewed
   again later).
3. Wait ~1–2 minutes for the project to provision.
4. Open **Project Settings → API**
   (`https://supabase.com/dashboard/project/_/settings/api`):
   - **Project URL** → this is `SUPABASE_URL`
     (`https://xxxxxxxxxxxx.supabase.co`).
5. Open **Project Settings → API Keys**
   (`https://supabase.com/dashboard/project/_/settings/api-keys`):
   - Use the **`service_role`** key (under *Legacy API keys*, a long `eyJ...`
     string) **or** a **Secret key** (`sb_secret_...`) from the new API Keys
     section. Both bypass Row-Level Security and work with
     `@supabase/supabase-js`.
   - Do **not** use the `anon` / `publishable` key — it can barely do anything.
   - This key is **server-side only** — never expose it in the browser.

```env
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...   (or sb_secret_...)
```

### Create the tables

Supabase dashboard → **SQL Editor** → **New query**
(`https://supabase.com/dashboard/project/_/sql/new`) → paste the contents of
[`db/schema.sql`](../db/schema.sql) → **Run**. It creates every table + index and
is safe to run more than once (`create ... if not exists`).

Docs: <https://supabase.com/docs/guides/api/api-keys>

---

## 7. `SALTA7_BASE_URL`

Base URL of the boosting API. Leave it at `https://salta7.store` — only change it
if the provider moves domains. Paths are appended directly
(`${BASE}/balance`, `${BASE}/task/create`), with **no** `/api` prefix.

```env
SALTA7_BASE_URL=https://salta7.store
```

---

## 8. `SALTA7_MASTER_TOKEN`  ⚠️ Required

The API key for **Salta7** — the external service that actually runs the boost
jobs. Every request goes out as
`Authorization: Bearer <SALTA7_MASTER_TOKEN>`.

### Where to get it

1. Create an account at **<https://salta7.store>**.
2. Add balance (the API bills per job / captcha).
3. In the **dashboard / account area**, copy the **Master Token** (a.k.a. "API
   Token"). API docs: <https://salta7.store/api>.

```env
SALTA7_MASTER_TOKEN=your-master-token
```

### Test it

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" https://salta7.store/balance
```

If your balance comes back, the token is valid.

---

## 9. `BOOSTS_PER_TOKEN` + `CAPTCHA_COST`

Boosting economics. Both have defaults — only set them to change the numbers.

```env
BOOSTS_PER_TOKEN=2
CAPTCHA_COST=0.015
```

- **`BOOSTS_PER_TOKEN`** — how many boosts one Discord token can provide. Used
  to work out how many stock tokens a key needs, and to cap the BYOT quantity.
- **`CAPTCHA_COST`** — the **default** USD price a BYOT user is charged per
  captcha that actually gets solved. The admin dashboard (**Pricing** tab) can
  override this at runtime; the env value is just the starting point / fallback.

---

## 10. `ADMIN_USERNAME` + `ADMIN_PASSWORD`  ⚠️ Required

The bootstrap **admin login** — for the dashboard (generate keys, manage stock
tokens, users, pricing, support link). You choose both; the account is
created automatically **on the first server start**.

```env
ADMIN_USERNAME=yourname
ADMIN_PASSWORD=a-long-unique-password
```

Rules / notes:

- `ADMIN_PASSWORD=changeme` is **rejected** (it's the `.env.example`
  placeholder).
- The password is stored bcrypt-hashed, never in plain text.
- If you change `ADMIN_PASSWORD` in `.env` later and restart, the existing
  account's password is updated automatically.
- BYOT users register themselves (role `user`); they can never reach the admin
  dashboard.
- Password generator:
  `node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"`

---

## 11. `ADMIN_PANEL_PASSWORD`  ⚠️ Required

A **second** password, on top of the admin login, that must be typed to open the
admin dashboard (the "Admin Access" screen). A stolen admin session still can't
reach the dashboard without it. **The server refuses to start if it's unset** —
no fallback, on purpose.

```env
ADMIN_PANEL_PASSWORD=another-long-unique-string
```

Make it different from `ADMIN_PASSWORD`. Same generator command as above.

---

## 12. `LOGO_URL`

Optional. The URL opened when the logo is clicked (e.g. your Telegram contact or
shop page). **Leave it empty** to make the logo non-clickable.

```env
LOGO_URL=https://t.me/boostredeem
```

---

## 13. Litecoin deposits (Tatum) — `TATUM_API_KEY` + `LTC_*`

Only needed if you want BYOT users to **top up their wallet themselves** with
Litecoin. Leave the whole block empty and the Deposit tab shows "top-up not
configured" — admins then credit balances by hand from the **Users** tab.

```env
TATUM_API_KEY=
TATUM_BASE_URL=https://api.tatum.io/v3
LTC_XPUB=
LTC_MNEMONIC=
LTC_MAIN_ADDRESS=
LTC_START_INDEX=1
LTC_FORWARD_FEE=0.0001
WEBHOOK_BASE_URL=
```

### Where to get the values

1. Create an account at **<https://tatum.io>** → **Dashboard → API Keys** →
   copy a key → `TATUM_API_KEY`.
2. Generate a Litecoin wallet **once** (from Tatum's dashboard "Generate wallet"
   tool, or `GET https://api.tatum.io/v3/litecoin/wallet` with your key). You get
   back a **mnemonic** and an **xpub**:
   - `LTC_XPUB` = the `xpub` value
   - `LTC_MNEMONIC` = the 24-word mnemonic — **secret, server-side only**
3. `LTC_MAIN_ADDRESS` = a Litecoin address you control where collected deposits
   are swept to (derive address index 0 from the same wallet, or use an exchange
   deposit address).
4. `LTC_START_INDEX` (default `1`), `LTC_FORWARD_FEE` (default `0.0001` LTC) —
   leave as-is unless you know you need to change them.
5. `WEBHOOK_BASE_URL` — your deployed site's public URL
   (`https://your-site.vercel.app`). When set, Tatum notifies the server the
   moment a deposit lands; when empty, the deposit page just polls. Optional.

How it works: each top-up derives a fresh address from `LTC_XPUB`; when the coins
arrive, the user's USD balance is credited at the locked rate and the funds are
forwarded to `LTC_MAIN_ADDRESS`.

---

## Optional variables (not in `.env.example`)

All have sensible defaults — only set them if you actually want to change
something.

| Variable | Default | Effect |
| --- | --- | --- |
| `SUPPORT_URL` | `https://t.me/boostredeem` | Support contact link on the redeem confirmation page. Better set it in the admin dashboard ("Integrations"); values set there win. |
| `ALLOWED_ORIGINS` | none | Comma-separated list of allowed CORS origins. Only needed if a **different** domain has to call the API. The site's own frontend doesn't need it. |
| `SPARE_STOCK_TOKENS` | `0` | Extra reserve tokens pulled per redeem (failover). |
| `MAX_BOOST_RETRIES` | `10` | How many times a failed job is retried with fresh stock tokens. |
| `BOOST_STALL_TIMEOUT_MS` | `240000` | After how many ms with no progress a job is marked "failed". |
| `DEBUG_BOOST` | – | `true` → verbose logging of the boost sync loop. |
| `VERCEL` | – | Set automatically by Vercel. **Do not set it yourself.** |

---

## Deploy to Vercel from scratch

You have: only the code. You want: a live, fully working site. Full walkthrough.

> **Never used code / a terminal / a hosting service before?** Read
> [`DEPLOY_BEGINNER.md`](DEPLOY_BEGINNER.md) instead — same thing, every click
> spelled out, with a glossary. The section below is the condensed version.

The repo ships a [`vercel.json`](../vercel.json) that runs the Express app
(`server.js`) as a single serverless function and bundles the `public/` folder —
so there is **no build step** and nothing to configure about the framework.

### Step 0 — Accounts you need first

| Service | URL | Free tier enough? |
| --- | --- | --- |
| Vercel | <https://vercel.com/signup> | yes |
| Supabase (database) | <https://supabase.com> | yes |
| Salta7 (boost API) | <https://salta7.store> | needs paid balance |
| GitHub (to import the repo) | <https://github.com> | yes — or use the Vercel CLI instead (Step 2b) |

### Step 1 — Provision Supabase

1. <https://supabase.com/dashboard/projects> → **New project**. Pick a region,
   set a database password, wait ~2 min.
2. **Project Settings → API**
   (`https://supabase.com/dashboard/project/_/settings/api`) → copy the
   **Project URL** → that's `SUPABASE_URL`.
3. **Project Settings → API Keys**
   (`https://supabase.com/dashboard/project/_/settings/api-keys`) → copy the
   **`service_role`** key (or an `sb_secret_...` key) → that's
   `SUPABASE_SERVICE_ROLE_KEY`.
4. **SQL Editor** (`https://supabase.com/dashboard/project/_/sql/new`) → paste
   all of [`db/schema.sql`](../db/schema.sql) → **Run**. You should see
   "Success. No rows returned".

Full detail: section 6 above.

### Step 2 — Get the code onto Vercel

**Option A — via GitHub (recommended, gives auto-deploy on push):**

1. Create a new repo at <https://github.com/new> (private).
2. Push this code to it:
   ```bash
   git remote add origin https://github.com/<you>/<repo>.git   # skip if already set
   git push -u origin main
   ```
3. <https://vercel.com/new> → **Import Git Repository** → pick that repo.

**Option B — via the Vercel CLI (no GitHub needed):**

```bash
npm i -g vercel
vercel login
vercel            # from the project folder — answer the prompts, creates the project
```

### Step 3 — Configure the Vercel project

On the import screen (Option A) or in **Project → Settings**:

- **Framework Preset:** `Other` (Vercel reads `vercel.json` — leave it).
- **Root Directory:** `./` (the repo root).
- **Build Command / Output Directory / Install Command:** leave all default /
  empty. There is no build.

### Step 4 — Add the environment variables

**Project → Settings → Environment Variables**
(<https://vercel.com/docs/environment-variables>) — add each of these, scope
**Production** (tick Preview too if you want preview deploys to work):

| Name | Value |
| --- | --- |
| `JWT_SECRET` | generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `SUPABASE_URL` | from Step 1.2 |
| `SUPABASE_SERVICE_ROLE_KEY` | from Step 1.3 |
| `SALTA7_MASTER_TOKEN` | from your Salta7 dashboard (see section 8) |
| `ADMIN_USERNAME` | you choose |
| `ADMIN_PASSWORD` | you choose (strong, not `changeme`) |
| `ADMIN_PANEL_PASSWORD` | you choose (different from `ADMIN_PASSWORD`) — **required** |
| `NODE_ENV` | `production` |

Optional:

| Name | Value |
| --- | --- |
| `SALTA7_BASE_URL` | `https://salta7.store` (this is the default) |
| `BOOSTS_PER_TOKEN` | `2` (default) |
| `CAPTCHA_COST` | `0.015` (default BYOT solve price) |
| `LOGO_URL` | your Telegram contact, or leave unset |
| `TATUM_API_KEY` + `LTC_XPUB` + `LTC_MNEMONIC` + `LTC_MAIN_ADDRESS` | only for self-serve Litecoin deposits — see section 13. Skip them and admins credit BYOT balances by hand. |

**Do not add** `PORT` or `VERCEL` — Vercel handles both.

> If you used the CLI (Option B), you can instead run
> `vercel env add JWT_SECRET production` (repeat per variable), or add them in the
> dashboard.

### Step 5 — Deploy

- Option A: click **Deploy** on the import screen (or push a commit — every push
  to the production branch redeploys).
- Option B: `vercel --prod`.

Wait for the build to finish (~1 min — it's just `npm install`).

### Step 6 — Verify it's fully running

1. **Health check:** open `https://<your-project>.vercel.app/api/health`
   → must return `{"status":"ok","service":"ninja-boost", ...}`.
   If you get the **"Under Development"** page instead, a required env var is
   missing (almost always `JWT_SECRET`) — check
   **Deployments → latest → Functions → logs**.
2. **Public panel:** open the site root → the Key Redeem panel loads. Paste any
   real `discord.gg/...` invite → the server preview card should appear (this
   proves outbound requests work).
3. **Admin:** click **Admin** → log in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
   The account is created automatically on this first login. If login fails with
   *"User no longer exists"* or a 500, your `SUPABASE_*` values are wrong or
   `db/schema.sql` wasn't run.
4. In the admin dashboard: add one stock token (Tokens tab), generate one key
   (Keys tab), then redeem that key on the public panel against a test server.
   A real boost = everything works end to end.

### Step 7 — Custom domain (optional)

**Project → Settings → Domains** → add your domain → follow the DNS records
Vercel shows (an `A` record or a `CNAME` to `cname.vercel-dns.com`).

### Step 8 — Day-to-day

- **Code changes:** push to the production branch → auto-deploys (Option A). Or
  `vercel --prod` (Option B).
- **Env var changes:** after editing a variable you must **redeploy**
  (Deployments → ⋯ → **Redeploy**) — running functions don't pick up new values.
- **Take the site offline:** add `MAINTENANCE_MODE` = `true` and redeploy;
  remove it (or set anything else) and redeploy to bring it back.

### Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "Under Development" page on every route | Required env var missing/invalid (usually `JWT_SECRET`). Check function logs. |
| Raw code / 404 on every route | `vercel.json` not at the repo root, or not committed. |
| Logo / CSS 404 | `public/**` not bundled — confirm `vercel.json` still has `"includeFiles": ["public/**"]`. |
| Admin login → 500 or "User no longer exists" | Wrong `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`, or `db/schema.sql` not run. |
| Boost starts then instantly fails | `SALTA7_MASTER_TOKEN` wrong, or the Salta7 account has no balance. Test with `curl -H "Authorization: Bearer <token>" https://salta7.store/balance`. |
| Function timeout on redeem | Rare — the boost runs on Salta7's side and the app only polls. If Salta7 is slow, raise the limit: add `"functions": { "server.js": { "maxDuration": 60 } }` to `vercel.json`. |

---

## Security checklist

- [ ] `.env` is **not** in git (`git status` to check)
- [ ] `JWT_SECRET` is random and ≥ 32 chars
- [ ] `SUPABASE_SERVICE_ROLE_KEY` appears **nowhere** in the frontend / `public/`
- [ ] `ADMIN_PASSWORD` is strong and unique, not `changeme`
- [ ] `SALTA7_MASTER_TOKEN` stays server-side only

# Deploying Ninja Boost — the complete beginner's guide

**Audience:** you have never written code, used a terminal, or put a website
online before. You were handed the Ninja Boost code (a folder of files) and you want a
working website on the internet.

**What you'll have at the end:** a live site at an address like
`https://ninja-boost.vercel.app` (or your own domain) with a **Key Redeem** panel
(anonymous), a **Booster** panel where logged-in users boost with their own
tokens, and an **admin dashboard** where you manage keys, tokens, users and
pricing.

**Time:** about 30–45 minutes.

**Cost:** Vercel and Supabase are free for this. **Salta7 is not** — it charges
per boost, so you need to load real money (usually crypto) into a Salta7 account.

---

## 1. Words you'll see, in plain language

| Word | What it actually means here |
| --- | --- |
| **Code / project / repository ("repo")** | The folder of Ninja Boost files you were given. |
| **Git / GitHub** | Git is a system that tracks versions of code. GitHub is a website that stores it online. Vercel reads your code from GitHub. |
| **GitHub Desktop** | A free app with buttons instead of typing — how you'll put your code on GitHub without learning commands. |
| **Deploy / hosting** | Putting your code on a computer that's always on, so the public can visit it. |
| **Vercel** | The company whose always-on computers will run Ninja Boost. It watches your GitHub repo and updates the live site whenever the code changes. |
| **Server / "serverless function"** | The program that answers each visit. On Vercel you don't manage a server — it runs your code on demand. You don't need to understand more than that. |
| **Database** | Where Ninja Boost saves data (the keys you generate, the Discord tokens you stock, the admin account). Ninja Boost uses **Supabase** for this. |
| **Supabase** | A free hosted database service. |
| **Salta7** | An outside service that does the actual Discord boosting. Ninja Boost sends it jobs. |
| **API / API key / token** | An API is a way for two programs to talk. An API key (or "token") is a long secret string that proves it's really you calling. Treat every key like a password. |
| **Environment variable** | A setting you give the program *without putting it in the code* — because it's secret (like a password) or different per site. You'll type these into Vercel's dashboard. |
| **`.env` file** | A local text file holding those settings while testing on your own computer. It must **never** go online. |
| **Domain** | The address people type, like `ninja-boost.com`. Optional — Vercel gives you a free `something.vercel.app` address. |

---

## 2. How the pieces fit together

```
   A visitor's web browser
            │
            ▼
   ┌──────────────────┐        stores keys / tokens / admin
   │      VERCEL       │ ─────────────────────────────────►  SUPABASE (database)
   │  (runs Ninja Boost)   │
   └──────────────────┘ ─────────────────────────────────►  SALTA7 (does the boosting)
            ▲                         sends boost jobs
            │
       reads the code from
            │
   ┌──────────────────┐
   │      GITHUB       │  ◄──── you upload the code here (once), with GitHub Desktop
   └──────────────────┘
```

You set each of these up once. After that, changing the code is: edit files →
click two buttons in GitHub Desktop → Vercel updates the live site by itself.

---

## 3. Before you start — get these ready

- A computer (Windows or Mac) and a web browser.
- An email address you can receive mail at.
- The **Ninja Boost code folder** on your computer. If you got it as a `.zip`,
  right-click → **Extract All** first, so you have a normal folder.
- A payment method for Salta7 (usually Litecoin/crypto — check their site).

Inside the code folder you should see files and folders like `server.js`,
`package.json`, `vercel.json`, `public`, `routes`, `db`. If you see a folder
called `node_modules`, **delete it** — it's huge, it's not needed for
deploying, and it just slows the upload. (It gets rebuilt automatically on
Vercel.) Also delete a file called `.env` if one exists — that's a private local
file and must not go online.

---

## 4. Create your accounts

Do these in order. For Vercel and Supabase, **choose "Continue with GitHub"** so
everything is linked.

### 4.1 GitHub

1. Go to <https://github.com/signup>.
2. Enter email, a password, a username. Verify your email.
3. Pick the **Free** plan.

### 4.2 Vercel

1. Go to <https://vercel.com/signup>.
2. Click **Continue with GitHub**. Approve the permission screen.
3. Choose the **Hobby** (free) plan when asked. Enter your name.

### 4.3 Supabase

1. Go to <https://supabase.com/dashboard/sign-in>.
2. Click **Continue with GitHub**. Approve.

### 4.4 Salta7

1. Go to <https://salta7.store> and register an account.
2. Find the **balance / top-up** page and load funds (this is the money that
   pays for boosts).
3. Leave this tab open — you'll grab a token from here in Part 7.

---

## 5. Put the code on GitHub (with GitHub Desktop)

### 5.1 Install GitHub Desktop

1. Go to <https://desktop.github.com> and download it. Install and open it.
2. **File → Options → Accounts → Sign in** (to GitHub). Approve in the browser.

### 5.2 Add your code folder

1. In GitHub Desktop: **File → Add local repository**.
2. Click **Choose…** and select your Ninja Boost code folder. Click **Add repository**.
3. If it says *"This directory does not appear to be a Git repository"*, click
   the blue **create a repository** link, then **Create repository** (leave the
   options as they are).

### 5.3 Commit and publish

1. On the left you'll see a list of every file — that's normal for the first
   time.
   - Make sure **`node_modules`** is **not** in that list. If it is, close
     GitHub Desktop, delete the `node_modules` folder from your code folder,
     reopen GitHub Desktop.
   - Make sure **`.env`** is **not** in the list. If it is, delete that file.
   - There should be a file called **`.gitignore`** in your folder — it's what
     keeps those two out. It's already included with Ninja Boost.
2. Bottom-left: in the **Summary** box type `first commit`, then click
   **Commit to main**.
3. Top of the window: click **Publish repository**.
4. In the popup:
   - Name: `ninja-boost` (or anything).
   - **Keep "Keep this code private" CHECKED.** ✅ Your keys will be in Vercel,
     not the code, but keep it private anyway.
   - Click **Publish repository**.

Your code is now on GitHub. You can see it at
`https://github.com/<your-username>/ninja-boost`.

---

## 6. Set up the database (Supabase)

### 6.1 Create the project

1. Go to <https://supabase.com/dashboard/projects> → **New project**.
2. Fill in:
   - **Name:** `ninja-boost`
   - **Database Password:** click **Generate a password**, then **copy it and
     paste it somewhere safe** (a notes file). You won't be able to see it again.
     *(Ninja Boost itself doesn't use this password, but you don't want to lose it.)*
   - **Region:** pick one close to you or your customers.
3. Click **Create new project**. Wait ~2 minutes while it sets up.

### 6.2 Copy the two values Ninja Boost needs

1. In the left sidebar click the **gear icon (Project Settings)** → **API**.
   (Direct link once you're logged in:
   `https://supabase.com/dashboard/project/_/settings/api`)
2. Under **Project URL** there's an address like
   `https://abcdefghijklmnop.supabase.co`. Copy it. This is your
   **`SUPABASE_URL`**.
3. Now go to **Project Settings → API Keys**
   (`https://supabase.com/dashboard/project/_/settings/api-keys`).
4. Find the key called **`service_role`** (it may be under a **"Legacy API
   keys"** tab; it's a very long string starting `eyJ…`). Click to reveal, then
   copy it. This is your **`SUPABASE_SERVICE_ROLE_KEY`**.
   - ⚠️ **Not** the `anon` / `public` / `publishable` key — that one can't do
     what Ninja Boost needs.
   - This key is powerful. Never paste it anywhere public.

Paste both into your safe notes file, labelled clearly.

### 6.3 Create the tables

1. Left sidebar → **SQL Editor** → **New query**
   (`https://supabase.com/dashboard/project/_/sql/new`).
2. Open the file **`db/schema.sql`** from your code folder:
   - Easiest: view it on GitHub at
     `https://github.com/<your-username>/ninja-boost/blob/main/db/schema.sql`, click
     the **Copy raw file** button.
   - Or open it on your computer with Notepad (right-click → Open with →
     Notepad) and select-all, copy.
3. Paste everything into the Supabase SQL editor box.
4. Click **Run** (bottom right).
5. You should see **"Success. No rows returned"**. That's correct — it just
   built the empty tables.

---

## 7. Get your Salta7 token

1. Back in your Salta7 account, open the **dashboard** or **account / API**
   page.
2. Find the **Master Token** (sometimes called **API Token**) — a long string.
   Copy it. This is your **`SALTA7_MASTER_TOKEN`**.
3. Put it in your safe notes file.

---

## 8. Make your secret key (`JWT_SECRET`)

This is a random string Ninja Boost uses to keep the admin login secure. You invent
it once. It must be long and random — don't type it by hand.

**On Windows:**

1. Click Start, type **PowerShell**, press Enter.
2. Paste this line and press Enter:
   ```powershell
   -join ((1..96) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
   ```
3. It prints a long string of letters and numbers. Copy it — that's your
   **`JWT_SECRET`**.

**On Mac:**

1. Open **Terminal** (Cmd+Space, type "Terminal").
2. Paste and press Enter:
   ```bash
   openssl rand -hex 48
   ```
3. Copy the output.

Put it in your safe notes file. Treat it like a master password — if it leaks,
regenerate it and update Vercel.

---

## 9. Pick your admin passwords

You just decide these now (write them in your notes file):

- **`ADMIN_USERNAME`** — e.g. `owner`
- **`ADMIN_PASSWORD`** — a strong password. **Not** the word `changeme` (Ninja Boost
  rejects that one).
- **`ADMIN_PANEL_PASSWORD`** — a *second*, different password. After you log in
  as admin, the dashboard asks for this one too. The site won't start without
  it.

Use a password manager, or run the PowerShell/Terminal command from Part 8 twice
(with a shorter length) to generate two random strings.

The admin account is created automatically the first time you log in after
deploying. Regular users (the "Booster" / BYOT side) register themselves and can
never see the admin dashboard.

---

## 10. Deploy on Vercel

### 10.1 Import the repo

1. Go to <https://vercel.com/new>.
2. You'll see **Import Git Repository**. If your `ninja-boost` repo isn't listed,
   click **Adjust GitHub App Permissions** (or **Add GitHub Account**), and give
   Vercel access to that repo. Come back.
3. Click **Import** next to `ninja-boost`.

### 10.2 Leave the build settings alone

- **Framework Preset:** it may say "Other" — that's fine.
- **Root Directory:** `./` — leave it.
- **Build and Output Settings:** don't touch. Ninja Boost has a `vercel.json` that
  tells Vercel everything; there is no build step.

### 10.3 Add the environment variables (the important part)

On the same screen, expand **Environment Variables**. Add each row below —
type the **Name** exactly as shown (capitals, underscores), paste the **Value**,
click **Add**, repeat.

| Name | Value to paste |
| --- | --- |
| `JWT_SECRET` | the random string from Part 8 |
| `SUPABASE_URL` | from Part 6.2 (the `https://….supabase.co` address) |
| `SUPABASE_SERVICE_ROLE_KEY` | the long `eyJ…` `service_role` key from Part 6.2 |
| `SALTA7_MASTER_TOKEN` | the token from Part 7 |
| `ADMIN_USERNAME` | the username you chose in Part 9 |
| `ADMIN_PASSWORD` | the first password from Part 9 |
| `ADMIN_PANEL_PASSWORD` | the *second* password from Part 9 |
| `NODE_ENV` | `production` |

Optional (add only if you want them):

| Name | Value |
| --- | --- |
| `LOGO_URL` | a link the logo opens when clicked, e.g. your Telegram contact |
| `SALTA7_BASE_URL` | `https://salta7.store` (this is already the default) |
| `CAPTCHA_COST` | `0.015` — what a BYOT user pays per captcha (you can also change this later in the admin **Pricing** tab) |
| `BOOSTS_PER_TOKEN` | `2` — how many boosts one token gives |

**Do not add** `PORT` or `VERCEL` — Vercel sets those itself.

### About the "Booster" (BYOT) side and Litecoin deposits

Ninja Boost has two panels: **Key Redeem** (works with just the variables above) and
**Booster / BYOT**, where a logged-in user pastes their *own* Discord tokens and
pays per captcha from a wallet balance.

Out of the box the BYOT wallet only fills up when **you** (as admin) hand a user
balance from the dashboard's **Users** tab. If you want users to top up
themselves with Litecoin, that needs a **Tatum** account and a Litecoin wallet —
add the `TATUM_API_KEY` and `LTC_*` variables described in
[`ENVIRONMENT.md` section 13](ENVIRONMENT.md). You can add these later; nothing
else breaks without them.

### 10.4 Deploy

Click **Deploy**. Watch the log for about a minute. When it finishes you'll see
**Congratulations** and a preview image with a link like
`https://ninja-boost-xxxx.vercel.app`.

---

## 11. Check that everything works

1. **Health check.** Open `https://<your-site>.vercel.app/api/health` in your
   browser. It must show:
   ```json
   {"status":"ok","service":"ninja-boost", ...}
   ```
   If instead you see a page saying **"Under Development"**, an environment
   variable is missing or misspelled — most often `JWT_SECRET`. Go to
   **Vercel → your project → Settings → Environment Variables**, fix it, then
   **Deployments → the top one → ⋯ menu → Redeploy**.

2. **The public page.** Open `https://<your-site>.vercel.app`. The Key Redeem
   panel should load (dark theme). Paste any real `discord.gg/...` invite into
   the Invite field — a little server preview card should pop up. That proves
   the site can reach the internet.

3. **The Booster panel.** Back on the site, click **Booster** (top right) →
   the login screen appears → **Register** a test account. You land on the
   account area with a Boost / Deposit / History / Profile row.

4. **The admin panel.** Log in (or register) with the exact `ADMIN_USERNAME` /
   `ADMIN_PASSWORD` you set — that account becomes the admin automatically. Click
   the **Admin** button, then enter your **`ADMIN_PANEL_PASSWORD`** on the "Admin
   Access" screen.
   - If login fails with *"User no longer exists"* or a server error, your
     `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` is wrong, or you skipped
     Part 6.3 (running `db/schema.sql`).
   - "Incorrect admin password" on the second screen → that's
     `ADMIN_PANEL_PASSWORD`, not your login password.

5. **Full end-to-end test.** In the admin panel:
   - **Tokens** tab → paste one Discord token → **Save**.
   - **Keys** tab → set "Boosts per Key" and "Number of Keys" to `1` →
     **Generate Keys** → copy the key it shows.
   - Go back to the public page, paste a test server invite + that key →
     **Redeem Now**. If it boosts, the whole chain works.
   - For BYOT: **Users** tab → give your test account a dollar or two of
     balance → on the Booster panel, paste a token + invite → **Start
     Boosting**.

---

## 12. Use your own domain (optional)

1. Buy a domain anywhere (Namecheap, Cloudflare, GoDaddy…).
2. In Vercel: **your project → Settings → Domains** → type your domain →
   **Add**.
3. Vercel shows you one or two DNS records to create. Go to your domain
   provider's DNS settings and add exactly those. Save.
4. Wait (minutes to a few hours). Vercel will show a green checkmark and set up
   HTTPS automatically.

---

## 13. Making changes later

**Changing the code (text, colours, wording…):**

1. Edit the files in your code folder.
2. Open **GitHub Desktop** → it shows what changed → type a short summary →
   **Commit to main** → **Push origin**.
3. Vercel notices the push and redeploys automatically in ~1 minute.

**Changing a setting (any environment variable, e.g. a new admin password):**

1. Vercel → your project → **Settings → Environment Variables** → edit → **Save**.
2. Go to **Deployments**, open the ⋯ menu on the newest one, click **Redeploy**.
   (Settings changes don't take effect until you redeploy.)

**Taking the site offline temporarily:**

1. Add an environment variable `MAINTENANCE_MODE` = `true` → redeploy. Visitors
   now see the "Under Development" page.
2. To go back online: delete that variable (or set it to `false`) → redeploy.

---

## 14. If something is broken

| What you see | What's wrong / what to do |
| --- | --- |
| "Under Development" page everywhere | A required environment variable is missing or misspelled (usually `JWT_SECRET`). Fix in Vercel Settings, then Redeploy. Check the exact error in **Deployments → newest → Functions / Logs**. |
| Plain text of the code, or "404" on everything | The `vercel.json` file didn't get uploaded. In GitHub Desktop, confirm `vercel.json` is in your repo; commit + push if not. |
| The site loads but has no styling / the logo is missing | The `public` folder didn't upload fully. Check it's on GitHub, push again. |
| Admin login → error or "User no longer exists" | Wrong `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY`, or you didn't run `db/schema.sql` (Part 6.3). |
| Redeem/boost fails instantly | Wrong `SALTA7_MASTER_TOKEN`, or your Salta7 balance is empty. |
| "I lost my Supabase keys" | Supabase → Project Settings → API / API Keys — they're always shown there; copy them again. |

To read the real error message: **Vercel → your project → Deployments → click
the newest → Functions** (or **Logs**). The red lines tell you which variable or
value is the problem.

---

## 15. Keep these safe

Never post, screenshot, commit, or paste into a chat:

- `SUPABASE_SERVICE_ROLE_KEY`
- `JWT_SECRET`
- `SALTA7_MASTER_TOKEN`
- `ADMIN_PASSWORD`
- your Discord stock tokens

They live **only** in Vercel's Environment Variables (and your private notes
file). They are never in the code and never in the GitHub repo. If one leaks:
generate a new one, update it in Vercel, and redeploy.

---

*Need the terse version for reference, or the meaning of every single variable?*
*See [`ENVIRONMENT.md`](ENVIRONMENT.md).*

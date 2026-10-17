# Discord bot (slash commands) — admins and premium accounts

Manage the panel from Discord: stock, keys, boosts, jobs. It is **not** a bot that has to stay online:
Discord calls `POST /api/discord/interactions` on your site (HTTP "Interactions"), so it works on Vercel.

| Command | What it does |
|---|---|
| `/stock` | Token stock only: unused, used, boosts available (unused × 2), and the premium accounts' unused tokens on a separate line. Same numbers as the admin Overview |
| `/restock tokens:… file:…` | Adds tokens to the platform stock — paste them (up to ~6000 characters) or attach a `.txt` file (up to 5000 tokens). Duplicates are skipped, tokens are never echoed |
| `/genkey boosts:14 count:5 note:…` | Generates 1–100 keys (source *admin*) and shows them, visible only to you |
| `/boost invite:… boosts:…` | Boosts a server now with the platform stock, no key needed |
| `/job id:…` | Progress of one job (refreshed live) with the customer tracking link |
| `/jobs count:…` | Latest jobs (default 5, max 10) |
| `/key code:…` | Value, delivered, server, owner and state of a key |
| `/revoke code:…` | Deletes an **unused platform** key (premium keys and used keys are refused) |
| `/balance` | Salta7 balance |

## Setup (once)
1. https://discord.com/developers/applications → **New Application**. Copy the **Application ID** and the **Public Key** (General Information).
2. **Bot** tab → *Reset Token* and copy it (used only to register the commands; it never needs to be on the server).
3. On the server (Vercel → Environment Variables) set:
   - `DISCORD_PUBLIC_KEY` — the Public Key
   - `DISCORD_ADMIN_IDS` — Discord user ids allowed to use the bot, comma separated
     (Discord → Settings → Advanced → Developer Mode, then right-click your profile → *Copy User ID*).
     **Empty = nobody can use it.**
   - `PUBLIC_URL` — your site address (already used elsewhere; gives the live-status links)
4. Deploy, then in the Developer Portal → General Information → **Interactions Endpoint URL**:
   `https://YOUR-SITE/api/discord/interactions` → Save. Discord sends a test request; it must say "saved".
5. Add the bot to your server (no bot permissions needed):
   `https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&scope=applications.commands`
6. Register the commands, from your computer, with a `.env` that has `DISCORD_APP_ID`, `DISCORD_BOT_TOKEN`
   and (recommended) `DISCORD_GUILD_ID` = your server id (instant; without it they are global and can take up to an hour):
   ```
   npm run discord:register
   ```
   Run it again whenever `services/discordCommands.js` changes.

## Good to know
- Every answer is ephemeral (only the person who ran the command sees it).
- Security: each request is checked against Discord's Ed25519 signature (and rejected if older than 5 min),
  then the user id must be in `DISCORD_ADMIN_IDS`. The commands are also hidden from non-administrators.
- Discord wants an answer within **3 seconds**. On a long-running host, `/boost` and `/restock` answer
  "thinking…" and edit the message when done. On **Vercel** (functions freeze after the answer) they run
  before answering: if one is slow Discord may show "did not respond" even though it worked — check `/jobs`.
- `/boost` uses the same engine as a reseller's "boost with my stock": it creates a one-off *direct* key,
  starts the job, and removes the key again if nothing could be started.


## For premium accounts: the same bot, on their own stock

The commands above also work for **premium accounts**, but they only ever touch **that account's own** stock,
keys, jobs and wallet — never the platform's and never another account's. Who is calling decides what the
command acts on:

| Caller | `/stock` `/restock` `/boost` … act on |
|---|---|
| a Discord id in `DISCORD_ADMIN_IDS` | the platform (as described above) |
| a premium account linked to its Discord | **that account's own stock**, keys and jobs |
| anybody else | nothing — the bot asks them to link first |

Differences for a premium account: `/boost` is paid from its wallet (same rule as the panel), `/genkey` keys
belong to it, `/revoke` only deletes its own **unused** keys, and `/balance` shows its **wallet** (not Salta7).
A premium account that ends (or is switched off) loses access immediately.

### Linking (once per premium account)
1. Run `db/migration_discord_premium.sql` in Supabase (adds the link columns).
2. In the panel: **API → Shared bot → Generate a link code** (valid 10 minutes, works once; only its hash is stored).
3. In Discord, in a server where the bot is: `/link code:NB-XXXX-XXXX`. Done — `/unlink` (or the panel button) undoes it.

One Discord account links to one premium account and the other way round.

### Update after deploying this version
- Re-register the commands (adds `/link` and `/unlink`, and makes the commands visible to everyone in the server,
  since premium accounts are not server administrators — the real gate is on the server):
  `node scripts/register-discord-commands.js`
- Premium accounts use the bot in the server where you added it. To keep the commands out of other members'
  menus, restrict them in Discord → Server Settings → Integrations → your bot.


## For premium accounts: their OWN bot, in their OWN server

A premium account can also run a bot of its own: **its own Discord application, added to its own server**, with the
same commands (`/stock /restock /genkey /boost /job /jobs /key /revoke /balance`) acting on **its stock only**.
Nothing is shared with the admin bot, and each account's requests are verified with **its own** public key.

Panel: **API → Your own Discord bot**.
1. Create an application at https://discord.com/developers/applications (New Application).
2. General Information: copy the **Application ID** and the **Public Key**. Bot tab: **Reset Token** and copy it.
3. Paste them in the panel, add the **Discord user ids allowed to use the bot** (only these can run commands),
   and **Save and register commands**. The bot token is used once to register the commands and is **never stored**.
4. Copy the **Interactions Endpoint URL** shown in the panel into the Developer Portal →
   General Information → *Interactions Endpoint URL* → Save (Discord sends a test request; it must say "saved").
5. Open the **Add the bot to your server** link shown in the panel and pick the server.

Details
- The commands are hidden from non-administrators by default (Discord lets the owner change that in Server Settings → Integrations); the real gate is the allowed-ids list.
- `/boost` is paid from the account's wallet, `/revoke` only deletes its own unused keys, `/balance` shows its wallet.
- When the premium ends the bot stops answering; `Disconnect` in the panel removes the settings.
- After an update that changes the commands, paste the bot token again and Save to register them again.
- Needs `DISCORD_PUBLIC_KEY` only for the shared bot; a personal bot needs nothing on the server except `PUBLIC_URL` (used to build the endpoint address).
- Run `db/migration_discord_ownbot.sql` once in Supabase.

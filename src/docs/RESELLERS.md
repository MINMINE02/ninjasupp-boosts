# Resellers (customers with their own stock and keys)

A reseller is a normal customer account that you switch on. They sell boosts to
**their** customers using **their own** token stock, completely separate from yours.

## Set up

1. **SQL** — run `db/migration_resellers.sql` in the Supabase SQL editor (safe to re-run).
   It needs `migration_sellauth.sql` and `migration_sellauth_serverlink.sql` to have been run before.
   Then run `db/migration_redeem_branding.sql` too: it lets each reseller pick the colour, icon and
   top-left name of their redeem page (Redeem Page tab). Without it everything else keeps working; only
   those three options can't be saved.
2. The customer **registers** on the customer panel (header → account → Register).
3. **Admin panel → Resellers → Add a reseller**: pick the account, optionally set a price per boost, *Enable reseller*.
   (Shortcut: **Users → Make reseller**.)
4. On their next page load their sidebar shows the extra entries below.

## What a reseller gets

| Menu | What it does |
| --- | --- |
| **Boost** | Same booster as every account (own tokens, paid from the wallet). |
| **Joiner** | Makes accounts from **their own stock** join a server (Salta7 `join`, up to 100 at once, no boost). Live progress and per-account results. Tokens are **not consumed**. |
| **Files** | Their own stock: paste or load a `.txt`, export, delete. Only their keys ever use these tokens. Includes the **Token checker**. |
| **Keys** | Generate keys in bulk (boosts per key, note), filter, search, copy, export, delete. |
| **API** | Create / revoke an API key (`nbk_…`, shown once, only its hash is stored), endpoints under `/api/v1`, and **their own SellAuth dynamic delivery**. |
| **Orders** | Boosts started with their keys, live status. |
| **Redeem Page** | Their own page `/r/<name>` with their title and support link (no platform branding). Only their keys work there. |
| **Settings** | Wallet, change password. |

Sidebar counters: tokens in stock · unused keys · boosts delivered.

## Isolation rules (tested)

- A key owned by a reseller draws **only** from that reseller's stock — if it runs short, the redeem fails
  (`409 Not enough stock`) and the key is released; it never falls back to your tokens or another reseller's.
- Your own keys draw **only** from your pool. Admin stock / keys / stats views only count your own rows.
- A reseller can only list, delete or read their own keys, tokens and orders.
- Disabling a reseller makes their keys unusable (`403`) until you enable them again; nothing is deleted.
- A reseller's key redeemed on another reseller's page is refused.

## Token checker

Free (Salta7 `check`). In **Files** (reseller) and **Admin → Stock** (platform pool): *Check my tokens* tests up to 1,000
unused tokens — valid / locked (phone, email, re-verify) / invalid, Nitro and days left, free boost slots.

- Only the pool of whoever starts it is checked; results of a check can only be read by its owner.
- *Delete invalid* / *Delete locked* remove **unused** tokens of that pool only — used tokens and other pools are never touched.
- One check at a time per pool. A token already checked 5 times in 24 h is skipped by Salta7.
- Run `db/migration_resellers.sql` first (adds `token_checks`).

## SellAuth dynamic delivery for resellers

Same mechanism as the platform's own (see `SELLAUTH.md`), but private to each reseller. In **API → SellAuth dynamic delivery**:

1. *Create my webhook address* → `https://YOUR-DOMAIN/api/sellauth/r/<24-char address>`.
2. Paste it in the SellAuth product (*Deliverables → Dynamic Delivery*), save the SellAuth secret in the panel.
3. Each order creates a key **in their key list** (source `sellauth`, server link stored); it only redeems with **their** stock.

The boost amount is chosen in this order: `?boosts=N` in the URL → a product link → “14 Boosts” in the name → their fallback.
Product links, secret and delivery log are per reseller (the same SellAuth ID can be linked differently by the platform and by each reseller).
Requests are signed (HMAC) with the reseller's own secret; retries return the same key. A disabled reseller's address answers `403`;
**New address** rotates it (the old one stops working).

## Joiner

- Run `db/migration_resellers.sql` again: it now also allows `join` jobs (`jobs_mode_check`).
- Uses only the reseller's own tokens; if they have fewer than requested the join is refused (`409`), it never touches
  another pool. One join at a time per reseller.
- **Cost** — like BYOT: nothing up front, the wallet must cover the worst case (accounts × captcha price), then only
  captchas really solved are charged at the *Pricing* value of Admin → Settings. `solver_down` / `solve_failed` are free.
  Polling twice never charges twice.
- A join with no progress for 10 minutes is marked `failed` (`JOIN_STALL_TIMEOUT_MS` to change).
- Joins are counted as **accounts joined**, never as boosts: they are excluded from boost totals, the reseller's
  Orders, and the admin boost chart. Admin → Jobs shows them (type `join`, owner), Admin → Resellers has a *Joins* column.

## Billing (optional)

*Price per boost* (set when enabling, editable in the Resellers table): when a redeem finishes, the boosts actually
**delivered** × price are taken from the reseller's wallet. `0` = free. A redeem is refused (`402`) when the wallet
cannot cover the boosts the key still owes. Top their balance up in **Admin → Users**.

## Public API (reseller key)

```
Authorization: Bearer nbk_xxxxxxxx      (or  X-API-Key: nbk_xxxxxxxx)
GET    /api/v1/me             balance, stock and key totals
GET    /api/v1/stock          unused / used tokens
POST   /api/v1/stock          { "tokens": ["…"] }
POST   /api/v1/keys           { "boosts": 14, "count": 1, "note": "" }
GET    /api/v1/keys?status=unused|redeemed
GET    /api/v1/keys/:code
DELETE /api/v1/keys/:code     unused keys only
```
Rate-limited to 120 requests/minute.

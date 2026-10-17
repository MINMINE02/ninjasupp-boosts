# Shop — premium + credit packs (`/shop`)

A standalone, very visual page where a customer buys **premium** and/or **credits** with a **pack**.
It signs in with the panel's session (same account, same wallet).

- **Credits** = the account's wallet balance (USD). Premium accounts spend them on the boosts they deliver.
- **Premium** = the reseller access (`users.reseller`). A pack can give it for N days or for life.
- A pack can give premium, credits, or both ("bundle"): e.g. *Pro Pack — $34.99 → premium 90 days + $30 credits*.

## Setup (once)
1. Run `db/migration_shop.sql` in the Supabase SQL editor. It creates `shop_packs`, `shop_orders`,
   `users.premium_until`, and seeds 7 example packs (3 bundles, 1 premium, 3 credit packs) — **edit the prices to your liking**.
2. Edit the packs in the admin panel → **Shop** (name, tagline, price, credits, premium length, badge, colour, features,
   order, on sale). "Boost price for new premium accounts" sets the per-boost fee of an account the first time it becomes premium.
3. Paying with the wallet works right away. **Litecoin** checkout uses the same Tatum setup as the wallet top-up
   (`TATUM_*` variables); without it the Litecoin option is shown as unavailable.

## How a purchase works
Every purchase is wallet-based: the **price is taken from the wallet, the pack's credits are added**, premium is granted.
- *Wallet*: done instantly.
- *Litecoin*: a deposit is created for the pack price, the page shows the QR / address / exact amount and updates by itself.
  When the deposit is confirmed (Tatum webhook or the page polling) the order finishes automatically.
  If the payment is a few cents short (the wallet accepts ≥ 95 %), the money stays in the wallet and the page offers
  "Finish my order" once the balance is enough.
- Prices always come from the database (the request only carries the pack id). Hidden packs can't be bought.
- Orders keep a copy of the pack (name, price, credits…), so editing a pack never rewrites history.
- A balance change that happens during the payment (e.g. a deposit) is never overwritten (optimistic update + retry);
  if granting premium fails after the debit, the money is given back.

## Premium length
- Buying again **adds** the days after the current end date. Lifetime packs and admin-granted premium (no end date)
  are never shortened.
- When the date passes, the premium flag is switched off automatically (the job driver does it every cycle, and
  a premium account's own API calls check first). Stock, keys and pages are kept — the panel is just locked
  until it is renewed. The customer's redeem pages stop working while premium is off.

## Limits / safety
- 12 checkouts per minute per IP; at most 5 unpaid Litecoin orders per account (unpaid orders close after 24 h; if the
  payment still arrives later, the wallet is credited as for any top-up).
- `/shop?pack=<slug>` opens a pack's checkout directly (handy for links in Discord or your SellAuth page).
- The panel's menu has a **Shop** entry, and the Premium tab of non-premium accounts links to it.
- **Orders** (button at the top right of `/shop`): lists every order (pack, what it gave, date, method, status, id). Tapping one opens its detail — recap, Litecoin amount, **address**, transaction id — and an order still waiting for its payment reopens the full payment page (address, amount, QR) and follows it live until it is confirmed. API: `GET /api/shop/orders/:id` returns `deposit` (address, amount, tx) and `qr`.

## Paiements Litecoin en attente (filet de sécurité)
- Le job driver revérifie toutes les ~20 s les dépôts Litecoin encore `pending` (7 derniers jours), même si le client a fermé la page
  ou si le webhook Tatum n'est pas configuré (`WEBHOOK_BASE_URL`). Dès que le paiement suffit, le wallet est crédité et la commande livrée.
- Une commande expirée (24 h) dont le paiement arrive quand même est **quand même livrée** (plus de paiement perdu).
- Paiement partiel (< 95 %) : la page affiche ce qui a été reçu et ce qui reste à envoyer **à la même adresse** ; les montants s'additionnent.

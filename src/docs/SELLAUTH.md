# SellAuth dynamic delivery

Every time a customer buys, SellAuth calls your server and the reply is shown
to the customer. Here the reply is **one fresh redeem key** worth N boosts.

```
POST https://YOUR-DOMAIN/api/sellauth/deliver
```

## Set up (5 minutes)

1. **Run the new SQL** — `db/schema.sql` is idempotent, re-run it in the Supabase SQL editor
   (adds `sellauth_products`, `sellauth_deliveries`, `redeem_keys.source/note`).
2. **Secret** — SellAuth → *Storefront → Configure → Miscellaneous* → copy the webhook secret.
   Save it in **Admin panel → SellAuth** (or set `SELLAUTH_WEBHOOK_SECRET`).
3. **Product** — in SellAuth open the product → *Deliverables* → **Dynamic Delivery** and set the URL:
   - `https://YOUR-DOMAIN/api/sellauth/deliver?boosts=14`  ← simplest: the amount is in the URL
   - or the plain URL, and link the SellAuth product/variant ID to an amount in **Admin panel → SellAuth → Product links**
4. **Custom field "Server Link"** — in the product's *Custom Fields*, add a **required** text field named
   `Server Link`. The buyer pastes their Discord invite there; it is read from the webhook payload,
   cleaned to `discord.gg/<code>` and saved on the key and in the delivery log (Admin → Keys / SellAuth).
   If SellAuth sends it under another name, change *Custom field name* in Admin → SellAuth.
   A buyer who leaves it empty still gets their key (they paid) — the row just shows a **no link** badge.
5. **Test** — buy the product with a 100 % coupon and check **Admin panel → SellAuth → Deliveries**.

## How the boost amount is chosen (first match wins)

1. `?boosts=N` on the webhook URL
2. A product link for the **variant ID**, then the **product ID**
3. A number followed by “boost(s)” in the variant/product name (e.g. “Server Boost 14 Boosts”)
4. The *Fallback boosts* value from the admin panel

If none applies the request is answered `422` and logged with the payload SellAuth sent
(open **Payload** on the failed row to see which ID to link). Nothing is delivered by guess.

## Guarantees

- **Signed** — the `X-Signature` header (HMAC-SHA256 of the raw body with your secret) is checked
  in constant time; anything else gets `401`.
- **Idempotent** — SellAuth retries on timeouts; the `Idempotency-Key` header is stored, so a retry
  returns the **same key** instead of creating a second one.
- **One line = one deliverable** — the reply is the bare key, plain text, HTTP 200.
- Keys are generated with `crypto.randomInt` and marked `source = sellauth` (filter them in **Keys**).

Put the redeem page URL in the product description so the customer knows where to use the key.

Resellers have their own private webhook and secret — see [`RESELLERS.md`](RESELLERS.md). Admin → SellAuth only shows and counts the platform's own deliveries and links.

-- ---------------------------------------------------------------------------
-- Shop — premium + credit packs (bought from the wallet or with Litecoin)
-- À coller dans Supabase -> SQL Editor -> Run. Sans risque : peut être relancé.
-- Prérequis : migration_resellers.sql (colonne users.reseller = « premium »).
--
--   credits  = le solde (wallet) du compte, en USD
--   premium  = users.reseller ; users.premium_until = date de fin (NULL = illimité / accordé par l'admin)
-- ---------------------------------------------------------------------------

alter table public.users add column if not exists premium_until timestamptz;

create table if not exists public.shop_packs (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique,
  name                text not null,
  tagline             text,
  kind                text not null default 'bundle' check (kind in ('premium', 'credits', 'bundle')),
  price_usd           numeric(12, 2) not null check (price_usd > 0),
  credits_usd         numeric(12, 2) not null default 0 check (credits_usd >= 0),   -- ajoutés au solde à l'achat
  grants_premium      boolean not null default false,
  premium_days        integer check (premium_days is null or premium_days > 0),     -- NULL + grants_premium = à vie
  premium_boost_price numeric(12, 4) check (premium_boost_price is null or premium_boost_price >= 0),  -- prix/boost appliqué à un compte qui devient premium (NULL = inchangé)
  badge               text,
  accent              text,                       -- couleur de la carte, ex. #ffb020
  features            jsonb not null default '[]'::jsonb,
  sort_order          integer not null default 0,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.shop_orders (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.users(id) on delete cascade,
  pack_id             uuid references public.shop_packs(id) on delete set null,
  -- Copie du pack au moment de l'achat : changer un prix ne touche jamais l'historique.
  pack_name           text not null,
  price_usd           numeric(12, 2) not null,
  credits_usd         numeric(12, 2) not null default 0,
  grants_premium      boolean not null default false,
  premium_days        integer,
  premium_boost_price numeric(12, 4),
  method              text not null check (method in ('wallet', 'ltc')),
  status              text not null default 'awaiting_payment'
                      check (status in ('awaiting_payment', 'processing', 'completed', 'cancelled')),
  deposit_id          uuid,                       -- dépôt Litecoin lié (method = ltc), sans FK volontairement
  premium_until       timestamptz,                -- résultat : fin du premium après cet achat (NULL = illimité)
  created_at          timestamptz not null default now(),
  completed_at        timestamptz
);
create index if not exists shop_orders_user_idx    on public.shop_orders (user_id, created_at desc);
create index if not exists shop_orders_deposit_idx on public.shop_orders (deposit_id);
create index if not exists shop_orders_status_idx  on public.shop_orders (status, created_at desc);

alter table public.shop_packs  enable row level security;
alter table public.shop_orders enable row level security;

-- Packs de départ (modifiables dans Admin -> Shop). Ne s'insèrent que si la table est vide.
insert into public.shop_packs (slug, name, tagline, kind, price_usd, credits_usd, grants_premium, premium_days, badge, accent, features, sort_order)
select * from (values
  ('starter',  'Starter Pack',  'Premium + credits to launch your shop',        'bundle',  14.99,  10.00, true,  30,   null,         '#ff2d3f',
    '["Premium for 30 days","$10 credits in your wallet","Own stock, keys and redeem page","Joiner, checker and API access"]'::jsonb, 10),
  ('pro',      'Pro Pack',      'The sweet spot for growing resellers',          'bundle',  34.99,  30.00, true,  90,   'BEST VALUE', '#ffb020',
    '["Premium for 90 days","$30 credits in your wallet","Everything in Starter","Priority support"]'::jsonb, 20),
  ('elite',    'Elite Pack',    'Lifetime premium and a serious credit stash',   'bundle',  99.00, 120.00, true,  null, 'LIFETIME',   '#a855f7',
    '["Premium forever","$120 credits in your wallet","Everything in Pro","Never pay for premium again"]'::jsonb, 30),
  ('premium-30','Premium · 30 days','Unlock the full reseller toolkit',          'premium',  9.99,   0.00, true,  30,   null,         '#38bdf8',
    '["Premium for 30 days","Own stock, keys and redeem page","Joiner, checker and API access"]'::jsonb, 40),
  ('credits-10','Credits $10',      'Top up and get a little extra',             'credits', 10.00,  10.50, false, null, null,         '#22d3ee',
    '["$10.50 credits (+5%)","Instant delivery"]'::jsonb, 50),
  ('credits-50','Credits $50',      'Our most popular top-up',                   'credits', 50.00,  57.50, false, null, '+15%',       '#22d3ee',
    '["$57.50 credits (+15%)","Instant delivery"]'::jsonb, 60),
  ('credits-100','Credits $100',    'Stock up and save the most',                'credits',100.00, 120.00, false, null, '+20%',       '#22d3ee',
    '["$120 credits (+20%)","Instant delivery"]'::jsonb, 70)
) as v(slug, name, tagline, kind, price_usd, credits_usd, grants_premium, premium_days, badge, accent, features, sort_order)
where not exists (select 1 from public.shop_packs);

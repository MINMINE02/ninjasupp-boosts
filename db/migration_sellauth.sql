-- Ninja Boost — migration SellAuth + admin panel
-- À coller dans Supabase -> SQL Editor -> Run. Sans risque : peut être relancé.

alter table public.redeem_keys add column if not exists source text not null default 'admin';
alter table public.redeem_keys add column if not exists note   text;

create table if not exists public.sellauth_products (
  id            uuid primary key default gen_random_uuid(),
  sellauth_id   text not null unique,
  label         text,
  boosts_value  integer not null check (boosts_value > 0),
  created_at    timestamptz not null default now()
);

create table if not exists public.sellauth_deliveries (
  id               uuid primary key default gen_random_uuid(),
  idempotency_key  text not null unique,
  invoice_id       text,
  product_id       text,
  product_name     text,
  boosts_value     integer,
  key_code         text,
  status           text not null default 'delivered' check (status in ('delivered', 'error')),
  error            text,
  payload          jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists sellauth_deliveries_created_idx on public.sellauth_deliveries (created_at desc);

alter table public.redeem_keys        add column if not exists server_link text;
alter table public.sellauth_deliveries add column if not exists server_link text;

alter table public.sellauth_products   enable row level security;
alter table public.sellauth_deliveries enable row level security;

-- Force l'API Supabase à voir les nouvelles tables/colonnes tout de suite
notify pgrst, 'reload schema';

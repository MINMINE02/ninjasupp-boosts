-- Ninja Boost — système Reseller (stock, clés, page de redeem et API par client)
-- À coller dans Supabase -> SQL Editor -> Run. Sans risque : peut être relancé.
-- Prérequis : migration_sellauth.sql déjà lancée (colonnes source / note sur redeem_keys).

-- Réglages par compte (activés par l'admin)
alter table public.users add column if not exists reseller            boolean not null default false;
alter table public.users add column if not exists boost_price         numeric(12, 4) not null default 0;  -- USD facturés au reseller par boost livré (0 = gratuit)
alter table public.users add column if not exists api_key_hash        text;
alter table public.users add column if not exists api_key_prefix      text;
alter table public.users add column if not exists api_key_created_at  timestamptz;
alter table public.users add column if not exists redeem_slug         text;
alter table public.users add column if not exists redeem_title        text;
alter table public.users add column if not exists support_url         text;
create unique index if not exists users_redeem_slug_key  on public.users (redeem_slug)  where redeem_slug is not null;
create unique index if not exists users_api_key_hash_key on public.users (api_key_hash) where api_key_hash is not null;

-- Propriétaire du stock / des clés / des jobs : NULL = toi (admin), sinon le reseller
alter table public.stock_tokens add column if not exists owner_id uuid references public.users(id) on delete cascade;
alter table public.redeem_keys  add column if not exists owner_id uuid references public.users(id) on delete cascade;
alter table public.jobs         add column if not exists owner_id uuid;   -- sans FK volontairement (historique conservé)
create index if not exists stock_tokens_owner_idx on public.stock_tokens (owner_id, status);
create index if not exists redeem_keys_owner_idx  on public.redeem_keys (owner_id);
create index if not exists jobs_owner_idx         on public.jobs (owner_id);

-- Joiner : les jobs de type 'join' (ajout de membres avec le stock du reseller)
alter table public.jobs drop constraint if exists jobs_mode_check;
alter table public.jobs add constraint jobs_mode_check check (mode in ('byot', 'key', 'join'));

-- ---------------------------------------------------------------------------
-- Token checker + livraison dynamique SellAuth par reseller
-- ---------------------------------------------------------------------------
create table if not exists public.token_checks (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid references public.users(id) on delete cascade,   -- NULL = stock de la plateforme
  salta7_job_id  text not null,
  total          integer not null default 0,
  status         text not null default 'running',
  counts         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  finished_at    timestamptz
);
create index if not exists token_checks_owner_idx on public.token_checks (owner_id, created_at desc);
alter table public.token_checks enable row level security;

alter table public.users add column if not exists sellauth_ref text;
alter table public.users add column if not exists sellauth_secret text;
alter table public.users add column if not exists sellauth_default_boosts integer not null default 0;
create unique index if not exists users_sellauth_ref_key on public.users (sellauth_ref) where sellauth_ref is not null;

alter table public.sellauth_products   add column if not exists owner_id uuid references public.users(id) on delete cascade;
alter table public.sellauth_deliveries add column if not exists owner_id uuid references public.users(id) on delete cascade;
create index if not exists sellauth_deliveries_owner_idx on public.sellauth_deliveries (owner_id, created_at desc);

-- un meme ID SellAuth peut etre lie par plusieurs owners (plateforme = owner NULL)
alter table public.sellauth_products drop constraint if exists sellauth_products_sellauth_id_key;
create unique index if not exists sellauth_products_owner_sid_key
  on public.sellauth_products ((coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid)), sellauth_id);

notify pgrst, 'reload schema';

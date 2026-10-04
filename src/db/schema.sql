-- ============================================================================
-- Ninja Boost - Supabase schema
--
-- Run this in the Supabase SQL editor (or via the CLI) to provision the
-- tables the backend expects. All access happens through the service_role
-- key on the server, so Row Level Security is left disabled here; enable it
-- and add policies if you ever expose these tables to the anon key.
-- ============================================================================

-- Needed for gen_random_uuid()
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Users
--   'admin'  — the bootstrap admin dashboard account
--   'user'   — a BYOT account (registers, deposits, boosts with own tokens)
--   The key/redeem flow itself is still anonymous (no account needed).
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  username      text not null unique,
  password_hash text not null,
  role          text not null default 'user' check (role in ('user', 'admin')),
  balance       numeric(20, 4) not null default 0,   -- USD wallet balance (4dp: captcha charges are $0.015 each)
  created_at    timestamptz not null default now()
);

-- For databases created before the BYOT wallet feature was added.
alter table public.users add column if not exists balance numeric(20, 4) not null default 0;
alter table public.users alter column balance type numeric(20, 4);

-- ---------------------------------------------------------------------------
-- Redeemable keys
--   Each key carries its own boost amount; redeeming one (no account needed)
--   starts a boost job for that many boosts.
--   Code format: 16 characters, uppercase letters + digits.
-- ---------------------------------------------------------------------------
create table if not exists public.redeem_keys (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  boosts_value     integer not null check (boosts_value > 0),
  boosts_delivered integer not null default 0,   -- cumulative across every redeem attempt
  redeemed_at      timestamptz,
  redeemed_invite  text,
  created_at       timestamptz not null default now()
);

-- Bring older `redeem_keys` tables up to date.
alter table public.redeem_keys add column if not exists redeemed_at      timestamptz;
alter table public.redeem_keys add column if not exists redeemed_invite  text;
alter table public.redeem_keys add column if not exists boosts_delivered integer not null default 0;

-- ---------------------------------------------------------------------------
-- Jobs (one row per Salta7 task we start)
--   mode: 'byot' (logged-in user, own tokens) or 'key' (anonymous redeem)
-- ---------------------------------------------------------------------------
create table if not exists public.jobs (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references public.users(id) on delete set null,
  key_id           uuid references public.redeem_keys(id) on delete set null,
  salta7_job_id    text,
  invite           text not null,
  mode             text not null check (mode in ('byot', 'key')),
  boosts_requested integer not null default 0,
  boosts_delivered integer not null default 0,
  tokens_used      integer not null default 0,
  status           text not null default 'pending',
  cost             numeric(12, 4) not null default 0,
  auto_retry       boolean not null default false,
  retry_count      integer not null default 0,   -- how many times the same tokens were resent
  last_progress_at timestamptz not null default now(),   -- last time boosts_delivered increased
  cached_items     jsonb not null default '[]'::jsonb,   -- per-token results carried across retries
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Bring older `jobs` tables up to date.
alter table public.jobs add column if not exists salta7_job_id    text;
alter table public.jobs add column if not exists boosts_delivered integer not null default 0;
alter table public.jobs add column if not exists tokens_used      integer not null default 0;
alter table public.jobs add column if not exists cost             numeric(12, 4) not null default 0;
alter table public.jobs add column if not exists auto_retry       boolean not null default false;
alter table public.jobs add column if not exists retry_count      integer not null default 0;
alter table public.jobs add column if not exists last_progress_at timestamptz not null default now();
alter table public.jobs add column if not exists updated_at       timestamptz not null default now();
alter table public.jobs add column if not exists cached_items     jsonb not null default '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- Stock tokens (admin-uploaded pool). When a key is redeemed, the required
-- number of tokens is drawn from here and used for the boost.
-- ---------------------------------------------------------------------------
create table if not exists public.stock_tokens (
  id          uuid primary key default gen_random_uuid(),
  token       text not null unique,   -- bare token only (used for Salta7 + uniqueness)
  full_line   text,                   -- original pasted line, e.g. "email:pass:token" (falls back to `token` when null)
  status      text not null default 'unused' check (status in ('unused', 'used')),
  used_at     timestamptz,
  used_by_job uuid,   -- job id that consumed this token (no FK to keep setup order-independent)
  created_at  timestamptz not null default now()
);

-- Bring older `stock_tokens` tables up to date.
alter table public.stock_tokens add column if not exists used_at     timestamptz;
alter table public.stock_tokens add column if not exists used_by_job uuid;
alter table public.stock_tokens add column if not exists full_line   text;

create index if not exists stock_tokens_status_idx on public.stock_tokens (status);

-- ---------------------------------------------------------------------------
-- Job token queue (key-mode jobs only)
--   Each reserved stock token gets its own row and is processed one at a
--   time as its own single-token Salta7 job. A failed/stalled attempt is
--   requeued at the back (queue_order bumped to the end) with attempts+1,
--   until it either succeeds or runs out of attempts ('exhausted').
-- ---------------------------------------------------------------------------
create table if not exists public.job_tokens (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.jobs(id) on delete cascade,
  token         text not null,
  attempts      integer not null default 0,
  status        text not null default 'queued' check (status in ('queued', 'running', 'success', 'exhausted')),
  salta7_job_id text,
  queue_order   integer not null default 0,
  started_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists job_tokens_job_id_idx on public.job_tokens (job_id);
create index if not exists job_tokens_job_id_queue_idx on public.job_tokens (job_id, queue_order);

-- ---------------------------------------------------------------------------
-- Deposits (Litecoin top-ups via Tatum) — BYOT wallet
--   One unique deposit address per top-up. When funds arrive the user's
--   balance is credited and the funds are forwarded to the main address.
-- ---------------------------------------------------------------------------
create table if not exists public.deposits (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references public.users(id) on delete cascade,
  currency         text not null default 'LTC',
  address          text not null,
  derivation_index integer not null,
  amount           numeric(20, 8),                    -- requested amount in LTC (nullable)
  usd_amount       numeric(20, 2),                    -- requested amount in USD
  rate             numeric(20, 8),                    -- locked USD price of 1 LTC
  received         numeric(20, 8) not null default 0, -- actually received (LTC)
  status           text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  tx_id            text,                              -- incoming transaction id
  forwarded        boolean not null default false,
  forward_tx_id    text,                              -- forwarding transaction id
  created_at       timestamptz not null default now(),
  completed_at     timestamptz
);

create index if not exists deposits_user_id_idx on public.deposits (user_id);
create index if not exists deposits_address_idx on public.deposits (address);
create index if not exists deposits_status_idx on public.deposits (status);

-- ---------------------------------------------------------------------------
-- Settings (admin-configurable pricing, key/value)
-- ---------------------------------------------------------------------------
create table if not exists public.settings (
  key        text primary key,
  value      numeric not null,
  updated_at timestamptz not null default now()
);

-- Seed the pricing default (ignored if it already exists).
insert into public.settings (key, value) values
  ('captcha_cost', 0.015)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Text config (admin-configurable strings, e.g. the support contact link)
-- ---------------------------------------------------------------------------
create table if not exists public.app_config (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- SellAuth dynamic delivery
--   redeem_keys.source / note : where a key came from ('admin' | 'sellauth')
--   sellauth_products         : SellAuth product/variant id -> boosts value
--   sellauth_deliveries       : one row per delivery call (idempotency + log)
-- ---------------------------------------------------------------------------
alter table public.redeem_keys add column if not exists source text not null default 'admin';
alter table public.redeem_keys add column if not exists note   text;

create table if not exists public.sellauth_products (
  id            uuid primary key default gen_random_uuid(),
  sellauth_id   text not null unique,      -- SellAuth product id or variant id
  label         text,
  boosts_value  integer not null check (boosts_value > 0),
  created_at    timestamptz not null default now()
);

create table if not exists public.sellauth_deliveries (
  id               uuid primary key default gen_random_uuid(),
  idempotency_key  text not null unique,   -- SellAuth "Idempotency-Key" header
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
alter table public.redeem_keys        add column if not exists server_link text;
alter table public.sellauth_deliveries add column if not exists server_link text;
create index if not exists sellauth_deliveries_created_idx on public.sellauth_deliveries (created_at desc);

create index if not exists jobs_user_id_idx on public.jobs (user_id);
create index if not exists jobs_salta7_job_id_idx on public.jobs (salta7_job_id);
create index if not exists redeem_keys_code_idx on public.redeem_keys (code);

-- ---------------------------------------------------------------------------
-- Row Level Security (defense-in-depth)
--
-- The app talks to the DB ONLY through the service_role key on the server,
-- and service_role BYPASSES RLS — so turning RLS on changes nothing for the
-- app. What it does change: the public `anon` key (designed to live in
-- browsers and effectively public) can no longer read or write these tables
-- directly through the Supabase REST API. With RLS enabled and NO policies,
-- anon/authenticated get exactly nothing — password hashes, tokens, balances
-- and deposits stay unreadable even if that key leaks. Safe and idempotent.
-- ---------------------------------------------------------------------------
alter table public.users        enable row level security;
alter table public.redeem_keys  enable row level security;
alter table public.jobs         enable row level security;
alter table public.stock_tokens enable row level security;
alter table public.job_tokens   enable row level security;
alter table public.deposits     enable row level security;
alter table public.settings     enable row level security;
alter table public.app_config   enable row level security;
alter table public.sellauth_products   enable row level security;
alter table public.sellauth_deliveries enable row level security;

-- ---------------------------------------------------------------------------
-- Resellers (stock / keys / redeem page / API per customer)
-- ---------------------------------------------------------------------------
-- Réglages par compte (activés par l'admin)
alter table public.users add column if not exists reseller            boolean not null default false;
alter table public.users add column if not exists boost_price         numeric(12, 4) not null default 0;  -- USD facturés au reseller par boost livré (0 = gratuit)
alter table public.users add column if not exists api_key_hash        text;
alter table public.users add column if not exists api_key_prefix      text;
alter table public.users add column if not exists api_key_created_at  timestamptz;
alter table public.users add column if not exists redeem_slug         text;
alter table public.users add column if not exists redeem_title        text;
alter table public.users add column if not exists support_url         text;
alter table public.users add column if not exists redeem_color        text;
alter table public.users add column if not exists redeem_icon         text;
alter table public.users add column if not exists redeem_brand        text;
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

-- Refresh the API schema cache so new tables/columns are visible immediately.
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Admin tools (see db/migration_admin_tools.sql)
-- ---------------------------------------------------------------------------
alter table public.users add column if not exists disabled   boolean not null default false;
alter table public.users add column if not exists admin_note text;
create table if not exists public.admin_audit (
  id         uuid primary key default gen_random_uuid(),
  admin_id   uuid,
  admin_name text,
  method     text not null,
  path       text not null,
  status     integer,
  summary    text,
  created_at timestamptz not null default now()
);
create index if not exists admin_audit_created_idx on public.admin_audit (created_at desc);

-- ---------------------------------------------------------------------------
-- Link embed of a reseller's redeem page (see db/migration_embed.sql)
-- ---------------------------------------------------------------------------
alter table public.users add column if not exists embed_title text;
alter table public.users add column if not exists embed_desc  text;
alter table public.users add column if not exists embed_color text;
alter table public.users add column if not exists embed_image text;

-- SellAuth direct delivery (see db/migration_sellauth_direct.sql)
alter table public.users add column if not exists sellauth_mode text;

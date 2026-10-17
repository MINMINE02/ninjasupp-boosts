-- Ninja Boost — colonnes SellAuth sur users (manquantes si migration_resellers
-- n'a pas été lancée, ou une vieille version sans ce bloc).
-- À coller dans Supabase -> SQL Editor -> Run. Sans risque, relançable.

alter table public.users add column if not exists sellauth_ref text;
alter table public.users add column if not exists sellauth_secret text;
alter table public.users add column if not exists sellauth_default_boosts integer not null default 0;
create unique index if not exists users_sellauth_ref_key on public.users (sellauth_ref) where sellauth_ref is not null;

-- Si le système reseller n'est pas encore là non plus, décommente / lance aussi
-- db/migration_resellers.sql (complet).

notify pgrst, 'reload schema';

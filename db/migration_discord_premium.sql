-- Bot Discord pour les comptes premium : un compte premium lie son compte Discord au panel
-- (code à usage unique → /link dans Discord), puis le bot agit sur SON stock uniquement.
-- À lancer une fois dans Supabase → SQL Editor. Idempotent.
alter table public.users add column if not exists discord_id           text;        -- id Discord lié (NULL = pas lié)
alter table public.users add column if not exists discord_link_hash    text;        -- sha256 du code de liaison en cours
alter table public.users add column if not exists discord_link_expires timestamptz; -- fin de validité du code (10 min)
create unique index if not exists users_discord_id_uidx on public.users (discord_id) where discord_id is not null;

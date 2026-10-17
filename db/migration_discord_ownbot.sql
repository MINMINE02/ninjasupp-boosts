-- Bot Discord PERSONNEL d'un compte premium : sa propre application Discord, dans son propre serveur.
-- Le token du bot n'est JAMAIS stocké (utilisé une seule fois pour enregistrer les commandes).
-- À lancer une fois dans Supabase → SQL Editor. Idempotent.
alter table public.users add column if not exists bot_app_id       text;   -- Application ID de son bot
alter table public.users add column if not exists bot_public_key   text;   -- Public Key (64 hex) : vérifie les requêtes Discord
alter table public.users add column if not exists bot_endpoint_id  text;   -- identifiant aléatoire de son URL d'interactions
alter table public.users add column if not exists bot_allowed_ids  text;   -- ids Discord autorisés (séparés par des virgules)
create unique index if not exists users_bot_endpoint_uidx on public.users (bot_endpoint_id) where bot_endpoint_id is not null;

-- Ninja Boost — livraison SellAuth DIRECTE : le mode (direct / clé) peut être choisi par chaque reseller.
-- À coller dans Supabase -> SQL Editor -> Run. Sans risque : peut être relancé.
-- (Le mode du site principal est réglé depuis le panel admin et stocké dans app_config : rien à créer.
--  Sans cette migration, les resellers restent en mode « direct » par défaut et peuvent
--  choisir par produit avec ?mode=key / ?mode=direct dans l'URL du webhook.)

alter table public.users add column if not exists sellauth_mode text;   -- 'direct' | 'key' | NULL (= direct)

notify pgrst, 'reload schema';

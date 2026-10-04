-- Ninja Boost — personnalisation de la page de redeem d'un reseller
-- (couleur, icône et nom affichés en haut à gauche).
-- À coller dans Supabase -> SQL Editor -> Run. Sans risque : peut être relancé.

alter table public.users add column if not exists redeem_color text;   -- ex. #3b82f6 (NULL = rouge Ninja par défaut)
alter table public.users add column if not exists redeem_icon  text;   -- data:image/...;base64,... ou https://... (NULL = logo Ninja)
alter table public.users add column if not exists redeem_brand text;   -- nom affiché en haut à gauche (NULL = « Ninja Boost »)

notify pgrst, 'reload schema';

-- Ninja Boost — aperçu (embed) du lien : ce qui s'affiche quand on colle le lien
-- dans Discord, Telegram, WhatsApp, X… (titre, description, couleur, image).
-- À coller dans Supabase -> SQL Editor -> Run. Sans risque : peut être relancé.
-- (L'embed du site principal est réglé depuis le panel admin et stocké dans app_config : rien à créer.)

alter table public.users add column if not exists embed_title text;   -- NULL = automatique (titre de la page)
alter table public.users add column if not exists embed_desc  text;   -- NULL = texte par défaut
alter table public.users add column if not exists embed_color text;   -- #rrggbb, NULL = couleur de la page
alter table public.users add column if not exists embed_image text;   -- data:image/...;base64,... ou https://... (NULL = icône de la page)

notify pgrst, 'reload schema';

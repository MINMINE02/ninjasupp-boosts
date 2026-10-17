-- Ninja Boost — outils des comptes premium : alertes Discord personnelles + domaine personnalisé.
-- À coller dans Supabase -> SQL Editor -> Run. Sans risque : peut être relancé.

-- Alertes Discord propres à chaque compte premium (webhook = secret, jamais réaffiché)
alter table public.users add column if not exists alert_webhook   text;      -- URL du webhook Discord (NULL = pas d'alertes)
alter table public.users add column if not exists alert_events    text;      -- ex. 'orders,completed,failed,lowstock' (NULL = tout)
alter table public.users add column if not exists alert_low_stock integer;   -- seuil de stock bas (NULL = 20)

-- Domaine personnalisé de la page redeem (ex. boost.monshop.com)
alter table public.users add column if not exists custom_domain             text;         -- le nom de domaine demandé
alter table public.users add column if not exists custom_domain_token       text;         -- preuve de propriété à mettre en TXT dans le DNS
alter table public.users add column if not exists custom_domain_verified_at timestamptz;  -- NULL tant que la propriété n'est pas prouvée
create unique index if not exists users_custom_domain_uidx on public.users (lower(custom_domain)) where custom_domain is not null;

notify pgrst, 'reload schema';

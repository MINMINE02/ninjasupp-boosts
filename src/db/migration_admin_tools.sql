-- Ninja Boost — outils du panel admin : suspension de compte, notes, journal d'activité.
-- À coller dans Supabase -> SQL Editor -> Run. Sans risque : peut être relancé.

alter table public.users add column if not exists disabled   boolean not null default false;  -- compte suspendu (connexion refusée)
alter table public.users add column if not exists admin_note text;                             -- note privée de l'admin sur ce compte

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

notify pgrst, 'reload schema';

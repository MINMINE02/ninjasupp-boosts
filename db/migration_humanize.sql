-- ---------------------------------------------------------------------------
-- Humanizer (Salta7 "humanize" tool) — optional profile (avatar / name / bio)
-- applied to the accounts that boosted a server through a key redeem.
--
-- Run once in the Supabase SQL editor. One row per redeem job that asked for
-- a profile; the job itself is untouched, so nothing else depends on it.
--   status: pending   -> asked for, waiting for the boost job to finish
--           running   -> Salta7 humanize job started
--           completed / partial / failed -> Salta7 result
--           skipped   -> no account joined, nothing to humanize
-- ---------------------------------------------------------------------------
create table if not exists public.job_humanize (
  job_id        uuid primary key references public.jobs(id) on delete cascade,
  fields        jsonb not null,                       -- { avatar?, name?, bio? } as sent to Salta7
  status        text not null default 'pending'
                check (status in ('pending', 'running', 'completed', 'partial', 'failed', 'skipped')),
  salta7_job_id text,
  total         integer not null default 0,           -- accounts sent to Salta7
  humanized     integer not null default 0,
  failed        integer not null default 0,
  started_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

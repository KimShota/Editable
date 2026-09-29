-- Durable job queue (creator-brand-memory plan, M0).
--
-- Replaces the in-memory concurrency counter in src/app/lib/pipelineQueue.ts
-- as the way slow work (analysis, profiling, generation) is scheduled: a
-- row here survives a restart, and later lets separate worker boxes pull
-- jobs from the same table without any code change.
--
-- Workers claim with `FOR UPDATE SKIP LOCKED` (see queue/workQueue.ts), so
-- two workers can never take the same row and neither blocks on the other.
create table if not exists work_queue (
  id           bigserial primary key,
  kind         text not null,
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  -- attempts counts CLAIMS, incremented when a worker takes the row, so a
  -- job that crashes its worker still burns an attempt.
  attempts     int not null default 0,
  max_attempts int not null default 3,
  -- Higher runs first. Interactive work (a creator waiting on their profile)
  -- outranks backfills.
  priority     int not null default 0,
  -- A retry sets this into the future (exponential backoff).
  run_after    timestamptz not null default now(),
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  result       jsonb,
  -- At most one live (queued or running) job per (kind, dedupe_key) — the
  -- same video is never analyzed twice concurrently.
  dedupe_key   text,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);

-- Partial: only queued rows are ever scanned by a claim, so finished rows
-- (the bulk of the table over time) cost the claim query nothing.
create index if not exists work_queue_claim_idx on work_queue (priority desc, run_after, id) where status = 'queued';

create unique index if not exists work_queue_dedupe_idx on work_queue (kind, dedupe_key) where dedupe_key is not null and status in ('queued', 'running');

-- Reclaiming stale locks scans running rows by lock age.
create index if not exists work_queue_running_idx on work_queue (locked_at) where status = 'running';

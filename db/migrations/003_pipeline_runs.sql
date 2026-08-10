-- Per-user pipeline spend tracking, for a daily build/render quota.
--
-- Every build/render spawn is a paid Anthropic call at minimum, and a
-- generation-heavy format adds Gemini/Higgsfield on top — the invite gate
-- controls who can trigger that spend, but nothing bounds how much any one
-- invited person can run up. This table is the count that quota.ts sums
-- over a rolling 24h window.
--
-- A row is inserted for every ATTEMPT (before the child process spawns),
-- not every success — a build that fails after making its Anthropic/Gemini
-- calls has still spent the money.
create table if not exists pipeline_runs (
  id         bigserial primary key,
  user_id    uuid not null references users (id) on delete cascade,
  job_id     text not null,
  kind       text not null check (kind in ('build', 'render')),
  created_at timestamptz not null default now()
);

-- Query shape is always "count this user's rows since <24h ago>" — see
-- quota.ts's checkAndRecordQuota.
create index if not exists pipeline_runs_user_time_idx on pipeline_runs (user_id, created_at desc);

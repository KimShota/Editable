-- Adds the job's format to each pipeline_runs row, enabling a per-format
-- LIFETIME cap on top of pipeline_runs' existing rolling-24h daily count
-- (see quota.ts's own FORMAT_LIFETIME_LIMITS) — some formats (e.g.
-- cinematic-debut-manifesto, "Kumar Method") are capped at a fixed total
-- per user, ever, not just a daily rate.
--
-- Nullable, no backfill: existing rows predate this cap and shouldn't
-- retroactively count against anyone — a per-format count naturally
-- ignores a null format_id since it never equals any real format's id.
alter table pipeline_runs add column if not exists format_id text;

-- Query shape is "count this user's rows for this one format_id" — see
-- quota.ts's countUsedForFormat.
create index if not exists pipeline_runs_user_format_idx on pipeline_runs (user_id, format_id);

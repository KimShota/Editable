-- Videos, their metrics, and the canonical per-video analysis
-- (creator-brand-memory plan, M0 / section 4).
--
-- The media itself is NOT stored here: media_key is a storage.ts key (local
-- disk in Phase 1, object storage later). It is nullable because a
-- 'reference' video (another creator's reel) has its media deleted once it
-- has been analyzed — only the derived features are kept.
create extension if not exists vector;

create table if not exists videos (
  id                uuid primary key default gen_random_uuid(),
  -- Null for library videos that no single user owns.
  owner_id          uuid references users (id) on delete cascade,
  relation          text not null check (relation in ('own', 'reference', 'library')),
  platform          text,
  platform_video_id text,
  url               text,
  posted_at         timestamptz,
  duration_sec      real,
  media_key         text,
  -- sha256 of the media bytes. The analysis is keyed on this, so the same
  -- file uploaded twice (or by two users) is analyzed once.
  content_hash      text,
  created_at        timestamptz not null default now()
);

create unique index if not exists videos_platform_uidx on videos (owner_id, platform, platform_video_id) where platform_video_id is not null;

create index if not exists videos_owner_idx on videos (owner_id, posted_at desc);

create index if not exists videos_content_hash_idx on videos (content_hash);

-- A time series per video: the same reel is measured again as it ages.
create table if not exists video_metrics (
  id            bigserial primary key,
  video_id      uuid not null references videos (id) on delete cascade,
  captured_at   timestamptz not null default now(),
  views         bigint,
  likes         bigint,
  comments      bigint,
  saves         bigint,
  shares        bigint,
  avg_watch_ms  bigint
);

create index if not exists video_metrics_video_idx on video_metrics (video_id, captured_at desc);

-- One analysis per (content, analyzer version): bumping ANALYZER_VERSION
-- (analysis/version.ts) adds new rows and leaves old ones, the same idea as
-- pipelineVersion.ts. style_vec is StyleFeatures projected into the shared
-- style space (style/vector.ts) — its width MUST equal style_specs.embedding
-- below and STYLE_DIMS.length in code (a test enforces this).
--
-- Visual (CLIP) and transcript-text embeddings are deliberately NOT columns
-- yet: a vector column's width is fixed by the model that produces it, so
-- they are added by the migration that introduces that model.
create table if not exists video_analyses (
  content_hash     text not null,
  analyzer_version text not null,
  analysis         jsonb not null,
  style_features   jsonb not null,
  style_vec        vector(24),
  created_at       timestamptz not null default now(),
  primary key (content_hash, analyzer_version)
);

create index if not exists video_analyses_style_vec_idx on video_analyses using hnsw (style_vec vector_cosine_ops);

-- StyleSpec store (creator-brand-memory plan, M0 / section 4): HOW a video
-- is cut and dressed, separate from what it is made of (a Format) and who it
-- must stay (a BrandKit). See src/backend/style/schemas.ts.
--
-- spec is the full StyleSpec JSON, validated by StyleSpecSchema on every
-- read and write. embedding is derived from it (style/vector.ts) and lives
-- in its own column so "similar styles" search is an index scan, not a
-- table scan. Its width MUST equal STYLE_DIMS.length in code and
-- video_analyses.style_vec (a test enforces this).
create table if not exists style_specs (
  id          uuid primary key default gen_random_uuid(),
  -- Null for specs no single user owns (curated library styles).
  owner_id    uuid references users (id) on delete cascade,
  source_kind text not null check (source_kind in ('self', 'creator', 'template', 'text')),
  source_ref  text not null default '',
  spec        jsonb not null,
  embedding   vector(24) not null,
  visibility  text not null default 'private' check (visibility in ('private', 'library')),
  created_at  timestamptz not null default now()
);

create index if not exists style_specs_owner_idx on style_specs (owner_id, created_at desc);

create index if not exists style_specs_embedding_idx on style_specs using hnsw (embedding vector_cosine_ops);

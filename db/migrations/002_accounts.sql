-- Accounts, sessions, and job ownership.
--
-- Identity lives in Postgres; the media itself stays on disk under
-- jobs/<id>/ exactly as before (see src/app/lib/jobs.ts). This table set is
-- only the OWNERSHIP index over those directories — which is what makes the
-- filesystem store safe to expose to more than one person, without moving
-- any pipeline state into the DB.

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  email_norm    text not null unique,
  password_hash text not null,
  is_admin      boolean not null default false,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

-- Signup is invite-only: a public URL with an open signup form is an open
-- door to the Anthropic/Gemini/Higgsfield keys every build spends against.
-- Mint codes with `npm run invites:mint`.
create table if not exists invites (
  code       text primary key,
  note       text,
  created_at timestamptz not null default now(),
  used_by    uuid references users (id) on delete set null,
  used_at    timestamptz
);

-- Only the SHA-256 of the cookie token is stored, so a dump of this table
-- can't be replayed as a live session.
create table if not exists sessions (
  token_hash text primary key,
  user_id    uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);

create index if not exists sessions_user_id_idx on sessions (user_id);
create index if not exists sessions_expires_at_idx on sessions (expires_at);

-- job_id is the on-disk directory name under jobs/. No FK to point at (the
-- job is a directory, not a row); the directory is the source of truth for
-- existence, this is the source of truth for who may open it.
create table if not exists job_owners (
  job_id     text primary key,
  user_id    uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists job_owners_user_id_idx on job_owners (user_id, created_at desc);

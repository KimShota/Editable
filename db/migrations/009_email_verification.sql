-- Email verification: closes the "sign up with a made-up address, get a
-- fresh free trial" loophole (see quota.ts's free-trial gate) by requiring
-- a clicked link before a free account can spend any build/render quota.
alter table users add column if not exists email_verified_at timestamptz;

-- Only the SHA-256 of the token is stored, same reasoning as sessions'
-- token_hash — a dump of this table can't be replayed to verify an
-- account that isn't yours.
create table if not exists email_verifications (
  token_hash text primary key,
  user_id    uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists email_verifications_user_id_idx on email_verifications (user_id);

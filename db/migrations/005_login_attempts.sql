-- Throttles /api/auth/login against unlimited password guessing. Each POST
-- records one row regardless of outcome (the throttle counts attempts, not
-- failures — same "attempt, not success" accounting as pipeline_runs); the
-- route checks BOTH counts below BEFORE running the actual (deliberately
-- expensive, scrypt) password verification, so a client already over
-- either limit doesn't get to spend CPU on it either.
--
-- No FK to users: email_norm may not correspond to a real account at all —
-- the throttle needs to catch guesses against emails that don't exist too.
create table if not exists login_attempts (
  id         bigserial primary key,
  email_norm text not null,
  ip_hash    text,
  created_at timestamptz not null default now()
);

-- Query shape is always "count rows for this email/ip since <N minutes
-- ago>" — see lib/loginAttempts.ts.
create index if not exists login_attempts_email_norm_idx on login_attempts (email_norm, created_at desc);
create index if not exists login_attempts_ip_hash_idx on login_attempts (ip_hash, created_at desc);

-- Waitlist signups from the landing page ("/#waitlist" form).
-- email_norm (trimmed + lowercased) is the dedupe key; email keeps the
-- as-typed casing for display/export.
create table if not exists waitlist (
  id           bigserial primary key,
  email        text not null,
  email_norm   text not null unique,
  status       text not null default 'active',
  referrer     text,
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  user_agent   text,
  ip_hash      text,
  created_at   timestamptz not null default now(),
  announced_at timestamptz
);

create index if not exists waitlist_created_at_idx on waitlist (created_at desc);
create index if not exists waitlist_ip_hash_idx on waitlist (ip_hash, created_at desc);

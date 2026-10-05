-- Landing-page leads (plan/landing-page-founder-proof.md section 3). A visitor
-- pastes their website, then leaves an email; the founder gets the notification
-- and follows up by hand during early access. The row is created at the first
-- step so a visitor who stops after pasting the website is still counted
-- (email stays null until step two).
create table if not exists leads (
  id           uuid primary key default gen_random_uuid(),
  website      text not null,
  email        text,
  referrer     text,
  utm          jsonb,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists leads_created_idx on leads (created_at desc);

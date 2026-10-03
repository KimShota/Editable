-- A founder adds someone to a brand's workspace by email. If that person
-- already has a verified account they join at once; otherwise the invitation
-- waits here and is claimed when they VERIFY their email (not at signup:
-- signup is open and starts a session before the address is proven, so
-- claiming there would let anyone who typed an invited address join).
-- plan/ui-ux-full-flow.md section 8, Admin > Brands.
create table if not exists workspace_invites (
  workspace_id uuid not null references workspaces (id) on delete cascade,
  email_norm   text not null,
  invited_by   uuid references users (id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, email_norm)
);

create index if not exists workspace_invites_email_idx on workspace_invites (email_norm);

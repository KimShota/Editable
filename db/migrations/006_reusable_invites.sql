-- Lets one invite code be shared across many signups instead of minting a
-- code per person. A reusable invite is never marked used (used_by/used_at
-- stay null forever for it) so the same "used_at is null" check in
-- signup() keeps working for ordinary single-use codes without a branch.
alter table invites add column if not exists reusable boolean not null default false;

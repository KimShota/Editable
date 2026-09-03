-- Adds subscription state to users. Stripe is the source of truth for
-- billing (renewal dates, payment methods); these columns are the local
-- cache the webhook keeps in sync so every other read (quota checks, Nav,
-- account page) never needs to call Stripe itself.
alter table users add column if not exists plan text not null default 'free';
alter table users add column if not exists stripe_customer_id text;
alter table users add column if not exists stripe_subscription_id text;

alter table users add constraint users_plan_check check (plan in ('free', 'premium'));

-- Partial (not plain unique) since most users have null in both columns.
create unique index if not exists users_stripe_customer_id_idx
  on users (stripe_customer_id) where stripe_customer_id is not null;
create unique index if not exists users_stripe_subscription_id_idx
  on users (stripe_subscription_id) where stripe_subscription_id is not null;

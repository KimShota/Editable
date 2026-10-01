-- Workspaces, brands and what onboarding learns about them
-- (plan/ai-brand-character-product.md, section 2).
--
-- A workspace is the billing and membership unit. A brand is one product
-- being promoted, with exactly one character (added by a later migration
-- together with the character pipeline). Everything the "paste your website"
-- intake extracts lands here and stays editable: the rows are the
-- customer-confirmed truth, and `brands.intake` keeps the raw extraction the
-- first draft came from.

create table if not exists workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  plan       text not null default 'free' check (plan in ('free', 'starter', 'growth', 'agency')),
  created_at timestamptz not null default now()
);

-- No roles in v1: every member can do everything (plan decision 17).
create table if not exists workspace_members (
  workspace_id uuid not null references workspaces (id) on delete cascade,
  user_id      uuid not null references users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index if not exists workspace_members_user_idx on workspace_members (user_id);

create table if not exists brands (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  name         text not null,
  website_url  text,
  -- BCP 47 tag ("en", "ja"). Drives research market, scripts, voice, captions.
  language     text not null default 'en',
  audience     text,
  tone         text[] not null default '{}',
  -- Daily posting time in the brand's own timezone (plan decision 13).
  post_time    time not null default '18:00',
  timezone     text not null default 'UTC',
  -- The raw BrandIntake the brand was drafted from (brand/intake/schemas.ts).
  intake       jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists brands_workspace_idx on brands (workspace_id, created_at);

-- One product per brand in v1; a table rather than columns so a brand can
-- later promote more than one product without a migration of its rows.
create table if not exists products (
  id          uuid primary key default gen_random_uuid(),
  brand_id    uuid not null references brands (id) on delete cascade,
  name        text not null,
  one_liner   text,
  -- How the product appears on screen (plan decision 8).
  type        text not null check (type in ('physical', 'digital', 'service')),
  url         text,
  features    text[] not null default '{}',
  price_note  text,
  created_at  timestamptz not null default now()
);

create index if not exists products_brand_idx on products (brand_id);

-- Reference media for product shots: photos for physical products, screen
-- recordings and screenshots for digital ones. Either a storage.ts key (an
-- uploaded or downloaded file) or, before download, only a source URL.
create table if not exists product_assets (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products (id) on delete cascade,
  kind        text not null check (kind in ('photo', 'screenshot', 'screen_recording', 'logo', 'other')),
  media_key   text,
  source_url  text,
  note        text,
  created_at  timestamptz not null default now(),
  check (media_key is not null or source_url is not null)
);

create index if not exists product_assets_product_idx on product_assets (product_id);

-- Applied to every text layer and caption the brand's videos render (plan
-- decision 9). Colours are "#rrggbb"; fonts are family names.
create table if not exists brand_kits (
  brand_id       uuid primary key references brands (id) on delete cascade,
  primary_color  text,
  secondary_color text,
  accent_color   text,
  text_color     text,
  background_color text,
  heading_font   text,
  body_font      text,
  logo_key       text,
  logo_url       text,
  updated_at     timestamptz not null default now()
);

-- Every paid API call, so cost per video is measured rather than guessed
-- (plan section 3.4: the $3/video target). brand_id is nullable: some spend
-- (library research) belongs to no single brand. ref is free-form context
-- ("intake", "shot:<id>") for grouping.
create table if not exists cost_ledger (
  id          bigserial primary key,
  brand_id    uuid references brands (id) on delete set null,
  provider    text not null,
  model       text not null,
  operation   text not null,
  units       jsonb not null default '{}'::jsonb,
  usd         numeric(12, 6) not null,
  ref         text,
  created_at  timestamptz not null default now()
);

create index if not exists cost_ledger_brand_idx on cost_ledger (brand_id, created_at);

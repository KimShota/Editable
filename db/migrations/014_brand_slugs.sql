-- A brand's files live under storage/brands/<slug>/ (character, sources,
-- plan, videos), keyed by a lowercase slug the CLIs take as --brand. This
-- column links a brand row (and through it the workspace and its members)
-- to those files, which is how the app decides who may see which brand
-- (plan/ui-ux-full-flow.md, section 2.1).
--
-- Nullable: brands drafted before this migration have no files yet. Unique
-- among the brands that do.
alter table brands add column if not exists slug text;

create unique index if not exists brands_slug_idx on brands (slug) where slug is not null;

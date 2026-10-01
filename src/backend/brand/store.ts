import type { QueryFn } from "../../app/lib/db";
import type { BrandIntake } from "./intake/schemas";

/**
 * Workspace and brand rows (migration 013). Takes a `query` function like the
 * queue and analysis stores, so tests run it against PGlite.
 */

export const createWorkspace = async (query: QueryFn, input: { name: string; ownerUserId?: string | null }): Promise<string> => {
  const [row] = await query(`insert into workspaces (name) values ($1) returning id`, [input.name]);
  const id = String(row.id);
  if (input.ownerUserId) {
    await query(`insert into workspace_members (workspace_id, user_id) values ($1, $2)`, [id, input.ownerUserId]);
  }
  return id;
};

export type CreatedBrand = { brandId: string; productId: string };

/**
 * Drafts a brand from an intake: the brand, the chosen product, its
 * reference images (as source URLs, not yet downloaded) and the brand kit.
 * One transaction's worth of inserts, but no transaction: the Neon HTTP
 * driver has none per statement, and a half-written draft is harmless (the
 * customer is about to review and edit every field anyway).
 */
export const createBrandFromIntake = async (
  query: QueryFn,
  input: { workspaceId: string; websiteUrl: string; intake: BrandIntake; productIndex?: number },
): Promise<CreatedBrand> => {
  const { intake } = input;
  const productIndex = input.productIndex ?? intake.recommendedProductIndex;
  const product = intake.products[productIndex];
  if (!product) throw new Error(`brand: intake has no product at index ${productIndex} (it lists ${intake.products.length})`);

  const [brand] = await query(
    `insert into brands (workspace_id, name, website_url, language, audience, tone, intake)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    // The brand is the product being promoted, not the parent company: a
    // group like Select, Inc. gets one brand per product it markets.
    [input.workspaceId, product.name, input.websiteUrl, intake.language, product.audience || intake.audience, intake.tone, JSON.stringify(intake)],
  );
  const brandId = String(brand.id);

  const [productRow] = await query(
    `insert into products (brand_id, name, one_liner, type, url, features, price_note)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [brandId, product.name, product.oneLiner, product.type, product.url, product.features, product.priceNote],
  );
  const productId = String(productRow.id);

  // Assets tagged with another product belong to that product, not this one.
  for (const asset of intake.assets.filter((a) => !a.productName || a.productName === product.name)) {
    await query(`insert into product_assets (product_id, kind, source_url) values ($1, $2, $3)`, [productId, asset.kind, asset.url]);
  }

  const kit = intake.brandKit;
  await query(
    `insert into brand_kits (brand_id, primary_color, secondary_color, accent_color, text_color, background_color, heading_font, body_font, logo_url)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [brandId, kit.primaryColor, kit.secondaryColor, kit.accentColor, kit.textColor, kit.backgroundColor, kit.headingFont, kit.bodyFont, kit.logoUrl],
  );

  return { brandId, productId };
};

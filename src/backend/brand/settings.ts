import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { QueryFn } from "../../app/lib/db";
import type { Storage } from "../storage";
import { readJsonIfExists, writeJson } from "../storageJson";
import { BrandIntakeSchema, ProductTypeSchema } from "./intake/schemas";
import { brandKeys, brandRoot } from "./keys";
import { type AssetKind, checkUpload } from "./uploads";

/**
 * What a customer can change about their brand (plan/ui-ux-full-flow.md §7):
 * the product, the brand kit, the language and posting time, and product
 * pictures. Character, voice and the cycle's angle are locked and not here.
 *
 * The database rows are the customer-confirmed truth, but the CLIs that write
 * scripts read intake.json, so a product edit is written to both and the two
 * cannot disagree about what the product is.
 */

const validTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const Hex = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Use a color like #2563eb").nullable();
const Font = z.string().trim().max(80).nullable();

export const SettingsPatchSchema = z.object({
  brand: z
    .object({
      language: z.enum(["en", "ja"]),
      postTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 18:00"),
      timezone: z.string().refine(validTimeZone, "That is not a known time zone"),
    })
    .partial()
    .optional(),
  product: z
    .object({
      name: z.string().trim().min(1, "The product needs a name").max(80),
      oneLiner: z.string().trim().max(300),
      type: ProductTypeSchema,
      url: z.union([z.literal("").transform(() => null), z.string().trim().url("Use a full web address, starting with https://").max(300)]).nullable(),
      features: z.array(z.string().trim().min(1).max(200)).max(12, "At most 12 features"),
    })
    .partial()
    .optional(),
  kit: z
    .object({ primaryColor: Hex, secondaryColor: Hex, accentColor: Hex, textColor: Hex, backgroundColor: Hex, headingFont: Font, bodyFont: Font })
    .partial()
    .optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export type Settings = {
  brand: { name: string; language: string; postTime: string; timezone: string };
  product: { name: string; oneLiner: string; type: "physical" | "digital" | "service"; url: string | null; features: string[] };
  kit: { primaryColor: string | null; secondaryColor: string | null; accentColor: string | null; textColor: string | null; backgroundColor: string | null; headingFont: string | null; bodyFont: string | null; logoKey: string | null };
};

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

const brandRow = async (query: QueryFn, slug: string) => {
  const rows = await query(`select id, name, language, post_time, timezone from brands where slug = $1`, [slug]);
  if (rows.length === 0) throw new SettingsError(`no brand "${slug}"`);
  return rows[0];
};

export const getSettings = async (query: QueryFn, slug: string): Promise<Settings> => {
  const b = await brandRow(query, slug);
  const [p] = await query(`select name, one_liner, type, url, features from products where brand_id = $1 order by created_at limit 1`, [b.id]);
  const [k] = await query(`select * from brand_kits where brand_id = $1`, [b.id]);
  const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  return {
    brand: { name: String(b.name), language: String(b.language), postTime: String(b.post_time).slice(0, 5), timezone: String(b.timezone) },
    product: {
      name: String(p?.name ?? b.name),
      oneLiner: String(p?.one_liner ?? ""),
      type: (p?.type as Settings["product"]["type"]) ?? "digital",
      url: text(p?.url),
      features: (p?.features as string[] | undefined) ?? [],
    },
    kit: {
      primaryColor: text(k?.primary_color),
      secondaryColor: text(k?.secondary_color),
      accentColor: text(k?.accent_color),
      textColor: text(k?.text_color),
      backgroundColor: text(k?.background_color),
      headingFont: text(k?.heading_font),
      bodyFont: text(k?.body_font),
      logoKey: text(k?.logo_key),
    },
  };
};

/** Applies a validated patch to the rows and to intake.json. Returns the new settings. */
export const updateSettings = async (query: QueryFn, storage: Storage, slug: string, input: unknown): Promise<Settings> => {
  const patch = SettingsPatchSchema.parse(input);
  const b = await brandRow(query, slug);
  const brandId = String(b.id);

  if (patch.brand) {
    const { language, postTime, timezone } = patch.brand;
    await query(`update brands set language = coalesce($2, language), post_time = coalesce($3::time, post_time), timezone = coalesce($4, timezone) where id = $1`, [brandId, language ?? null, postTime ?? null, timezone ?? null]);
  }

  if (patch.product) {
    const p = patch.product;
    const [row] = await query(`select id from products where brand_id = $1 order by created_at limit 1`, [brandId]);
    if (row) {
      await query(
        `update products set name = coalesce($2, name), one_liner = coalesce($3, one_liner), type = coalesce($4, type),
                url = case when $5::boolean then $6 else url end, features = coalesce($7::text[], features) where id = $1`,
        [row.id, p.name ?? null, p.oneLiner ?? null, p.type ?? null, p.url !== undefined, p.url ?? null, p.features ?? null],
      );
    }
    // The brand is the product being promoted, so renaming it renames the brand.
    if (p.name) await query(`update brands set name = $2 where id = $1`, [brandId, p.name]);
    await syncIntake(storage, slug, p);
  }

  if (patch.kit) {
    const k = patch.kit;
    const col: Record<keyof NonNullable<SettingsPatch["kit"]>, string> = {
      primaryColor: "primary_color", secondaryColor: "secondary_color", accentColor: "accent_color", textColor: "text_color",
      backgroundColor: "background_color", headingFont: "heading_font", bodyFont: "body_font",
    };
    await query(`insert into brand_kits (brand_id) values ($1) on conflict do nothing`, [brandId]);
    for (const [key, value] of Object.entries(k)) {
      if (value === undefined) continue;
      await query(`update brand_kits set ${col[key as keyof typeof col]} = $2, updated_at = now() where brand_id = $1`, [brandId, value]);
    }
  }
  return getSettings(query, slug);
};

/** Keeps intake.json (read by the script writer) in step with a product edit. */
const syncIntake = async (storage: Storage, slug: string, p: NonNullable<SettingsPatch["product"]>): Promise<void> => {
  const key = brandKeys(slug).intake;
  const raw = (await readJsonIfExists(storage, key)) as { intake?: unknown } | null;
  if (raw === null) return;
  const wrapped = raw.intake !== undefined;
  const intake = BrandIntakeSchema.parse(wrapped ? raw.intake : raw);
  const i = intake.recommendedProductIndex;
  const product = intake.products[i] ?? intake.products[0];
  if (!product) return;
  Object.assign(product, {
    ...(p.name !== undefined && { name: p.name }),
    ...(p.oneLiner !== undefined && { oneLiner: p.oneLiner }),
    ...(p.type !== undefined && { type: p.type }),
    ...(p.url !== undefined && { url: p.url }),
    ...(p.features !== undefined && { features: p.features }),
  });
  await writeJson(storage, key, wrapped ? { ...raw, intake } : intake);
};

export type ProductAsset = { id: string; kind: string; mediaKey: string | null; sourceUrl: string | null; note: string | null };

export const listProductAssets = async (query: QueryFn, slug: string): Promise<ProductAsset[]> => {
  const b = await brandRow(query, slug);
  const rows = await query(
    `select a.id, a.kind, a.media_key, a.source_url, a.note from product_assets a join products p on p.id = a.product_id where p.brand_id = $1 order by a.created_at, a.id`,
    [b.id],
  );
  return rows.map((r) => ({ id: String(r.id), kind: String(r.kind), mediaKey: (r.media_key as string | null) ?? null, sourceUrl: (r.source_url as string | null) ?? null, note: (r.note as string | null) ?? null }));
};

/** Stores an uploaded picture or recording and records it. A logo also becomes the brand kit's logo. */
export const addProductAsset = async (query: QueryFn, storage: Storage, slug: string, input: { kind: string; bytes: Buffer }): Promise<ProductAsset> => {
  const { sniffed, kind } = checkUpload(input.kind, input.bytes.length, input.bytes.subarray(0, 16));
  const b = await brandRow(query, slug);
  const [product] = await query(`select id from products where brand_id = $1 order by created_at limit 1`, [b.id]);
  if (!product) throw new SettingsError("This brand has no product to attach it to.");

  const key = `${brandRoot(slug)}/product/uploads/${randomUUID()}.${sniffed.ext}`;
  await storage.putBuffer(key, input.bytes);
  const [row] = await query(`insert into product_assets (product_id, kind, media_key) values ($1, $2, $3) returning id`, [product.id, kind satisfies AssetKind, key]);
  if (kind === "logo") {
    await query(`insert into brand_kits (brand_id) values ($1) on conflict do nothing`, [b.id]);
    await query(`update brand_kits set logo_key = $2, updated_at = now() where brand_id = $1`, [b.id, key]);
  }
  return { id: String(row.id), kind, mediaKey: key, sourceUrl: null, note: null };
};

export const removeProductAsset = async (query: QueryFn, storage: Storage, slug: string, assetId: string): Promise<boolean> => {
  const b = await brandRow(query, slug);
  const rows = await query(
    `delete from product_assets a using products p where a.id = $2 and a.product_id = p.id and p.brand_id = $1 returning a.media_key`,
    [b.id, assetId],
  );
  if (rows.length === 0) return false;
  const key = rows[0].media_key as string | null;
  if (key?.startsWith(`${brandRoot(slug)}/product/uploads/`)) {
    await storage.remove(key);
    await query(`update brand_kits set logo_key = null where brand_id = $1 and logo_key = $2`, [b.id, key]);
  }
  return true;
};

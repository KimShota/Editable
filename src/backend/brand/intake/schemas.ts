import { z } from "zod";

/**
 * What "paste your website" drafts (plan decision 27). Every field is a
 * suggestion the customer confirms or edits in onboarding; nothing here is
 * trusted as final.
 *
 * Kept free of zod refinements (regex, min/max): the schema is also the
 * structured-output format sent to Claude, and plain types translate
 * cleanly. Values are checked after parsing instead (normalizeIntake).
 */

export const ProductTypeSchema = z.enum(["physical", "digital", "service"]);

export const IntakeProductSchema = z.object({
  name: z.string(),
  oneLiner: z.string().describe("What it is and who it is for, in one sentence."),
  type: ProductTypeSchema.describe("physical = a thing you hold; digital = app, SaaS, website, AI tool; service = consulting, agency, coaching, venue."),
  url: z.string().nullable().describe("The product's own page or site if the website links to one, else null."),
  features: z.array(z.string()).describe("Up to 6 concrete features or benefits, in the site's own terms."),
  priceNote: z.string().nullable().describe("Price or pricing model if stated, else null."),
  audience: z.string().describe("Who it is for."),
  evidence: z.string().describe("The phrase or section of the site this product was found in."),
});

export const IntakeAssetSchema = z.object({
  url: z.string(),
  kind: z.enum(["photo", "screenshot", "logo", "other"]).describe("photo = physical product photo; screenshot = UI/app screenshot or mockup; logo = brand mark."),
  productName: z.string().nullable().describe("Which product it shows, if any."),
});

export const BrandIntakeSchema = z.object({
  companyName: z.string(),
  summary: z.string().describe("What the company does, 1-2 sentences."),
  isMultiProduct: z.boolean().describe("True when the site is a company or group presenting several distinct products."),
  products: z.array(IntakeProductSchema).describe("Every distinct product or service the site presents, most prominent first."),
  recommendedProductIndex: z
    .number()
    .int()
    .describe("Index into products of the one best suited to a daily short-form video series with a recurring character, and the one to promote first."),
  recommendationReason: z.string(),
  audience: z.string().describe("The brand's target audience overall."),
  tone: z.array(z.string()).describe("Up to 4 adjectives for the brand's voice, as the site itself sounds."),
  language: z.string().describe('Primary content language as a BCP 47 tag, e.g. "en", "ja".'),
  otherLanguages: z.array(z.string()).describe("Other languages the site is offered in."),
  brandKit: z.object({
    primaryColor: z.string().nullable().describe('"#rrggbb" chosen from the measured colours; the most brand-defining one.'),
    secondaryColor: z.string().nullable(),
    accentColor: z.string().nullable(),
    textColor: z.string().nullable(),
    backgroundColor: z.string().nullable(),
    headingFont: z.string().nullable().describe("From the measured font names only."),
    bodyFont: z.string().nullable(),
    logoUrl: z.string().nullable(),
  }),
  assets: z.array(IntakeAssetSchema).describe("Images from the measured list useful as product or brand reference, best first, at most 12."),
  gaps: z.array(z.string()).describe("What the site did not reveal that onboarding should ask the customer for (e.g. screen recordings of the app)."),
});

export type ProductType = z.infer<typeof ProductTypeSchema>;
export type IntakeProduct = z.infer<typeof IntakeProductSchema>;
export type BrandIntake = z.infer<typeof BrandIntakeSchema>;

const HEX6 = /^#[0-9a-f]{6}$/i;

/** Post-parse cleanup: keeps only values that are actually usable (valid hex
 *  colours, asset URLs that were in the measured list, an in-range product
 *  index), so a model slip becomes a null the customer fills in rather than
 *  a broken value downstream. */
export const normalizeIntake = (intake: BrandIntake, measured: { imageUrls: Set<string> }): BrandIntake => {
  const color = (c: string | null): string | null => (c && HEX6.test(c) ? c.toLowerCase() : null);
  const kit = intake.brandKit;
  return {
    ...intake,
    recommendedProductIndex: intake.products.length === 0 ? 0 : Math.min(Math.max(0, intake.recommendedProductIndex), intake.products.length - 1),
    brandKit: {
      ...kit,
      primaryColor: color(kit.primaryColor),
      secondaryColor: color(kit.secondaryColor),
      accentColor: color(kit.accentColor),
      textColor: color(kit.textColor),
      backgroundColor: color(kit.backgroundColor),
      logoUrl: kit.logoUrl && measured.imageUrls.has(kit.logoUrl) ? kit.logoUrl : null,
    },
    assets: intake.assets.filter((a) => measured.imageUrls.has(a.url)).slice(0, 12),
    tone: intake.tone.slice(0, 4),
  };
};

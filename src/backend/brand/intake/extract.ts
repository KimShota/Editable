import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { anthropicCostEntry, type CostSink } from "../../cost/ledger";
import type { SiteSignals } from "./fetchSite";
import { type BrandIntake, BrandIntakeSchema, normalizeIntake } from "./schemas";

/**
 * Website signals → a drafted BrandIntake, in one Claude call.
 *
 * The model only JUDGES here: which colour is the brand colour, which
 * product to lead with, what the tone is. Everything it can pick from
 * (colours, fonts, image URLs) was measured by signals.ts and is handed to
 * it as a list; normalizeIntake drops anything it invents.
 */

const DEFAULT_MODEL = "claude-opus-5-5";
/** Server-side fallback if the primary model declines (plan: Claude for all
 *  LLM work). */
const FALLBACK_MODEL = "claude-opus-4-8";
const TIMEOUT_MS = 180_000;

const ENTRY_TEXT_CHARS = 12_000;
const EXTRA_TEXT_CHARS = 4_000;

const SYSTEM = `You draft a brand profile for Katalab, a product that makes a brand a recurring AI character and posts short-form videos (TikTok, Reels, Shorts) in one niche every day.

You are given measurements taken from the brand's website: page text, headings, links, images, colours with occurrence counts, and font names. Produce the brand profile as structured output.

Rules:
- Base every field on the measurements. Colours, fonts, the logo URL and asset URLs must be copied exactly from the measured lists; if nothing fits, use null or an empty list.
- Colours: prefer ones the site declares as its theme and ones used often; a near-white or near-black is usually background or text, not the primary colour, unless the site is deliberately monochrome, in which case say so by using it.
- Products: list each distinct product or service separately, even when it lives on another domain the site links to (use that link as its url).
- The recommended product is the one where a daily short-form series with a recurring character is most likely to build an audience and drive sign-ups or sales.
- Language: the language of this page's content, not every language the site offers.
- Gaps: name what onboarding must ask for that the website cannot provide, concretely.`;

export const buildIntakePrompt = (site: SiteSignals): string => {
  const [entry, ...extras] = site.pages;
  const lines: string[] = [];
  lines.push(`ENTRY PAGE: ${entry.url}`);
  lines.push(`html lang: ${entry.lang ?? "unknown"}; alternates: ${Object.entries(entry.alternates).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
  lines.push(`title: ${entry.title ?? ""}`);
  for (const key of ["description", "og:title", "og:description", "og:site_name", "application-name", "keywords"]) {
    if (entry.meta[key]) lines.push(`meta ${key}: ${entry.meta[key]}`);
  }
  lines.push(`\nHEADINGS:\n${entry.headings.join("\n")}`);
  lines.push(`\nTEXT:\n${entry.text.slice(0, ENTRY_TEXT_CHARS)}`);
  lines.push(`\nLINKS (text → url, [ext] = another domain):\n${entry.links.map((l) => `${l.text || "(no text)"} → ${l.href}${l.external ? " [ext]" : ""}`).join("\n")}`);
  for (const page of extras) {
    lines.push(`\n--- OTHER PAGE: ${page.url} (title: ${page.title ?? ""})`);
    lines.push(page.text.slice(0, EXTRA_TEXT_CHARS));
  }
  const images = [...new Map(site.pages.flatMap((p) => p.images).map((i) => [i.src, i])).values()];
  lines.push(`\nMEASURED IMAGES (url | alt):\n${images.map((i) => `${i.src} | ${i.alt}`).join("\n") || "none"}`);
  lines.push(`\nMEASURED ICONS:\n${[...new Set(site.pages.flatMap((p) => p.icons))].join("\n") || "none"}`);
  lines.push(`\nMEASURED COLOURS (hex × occurrences, HTML + stylesheets; theme-color weighted):\n${site.colors.map((c) => `${c.hex} ×${c.count}`).join("\n") || "none"}`);
  lines.push(`\nMEASURED FONTS:\n${site.fonts.join("\n") || "none"}`);
  return lines.join("\n");
};

export type ExtractOptions = {
  model?: string;
  costSink?: CostSink;
  brandId?: string | null;
  client?: Anthropic;
};

export const extractBrandIntake = async (site: SiteSignals, options: ExtractOptions = {}): Promise<BrandIntake> => {
  const model = options.model ?? process.env.INTAKE_MODEL ?? DEFAULT_MODEL;
  const client = options.client ?? new Anthropic({ timeout: TIMEOUT_MS });

  const response = await client.beta.messages.parse({
    model,
    max_tokens: 16_000,
    betas: ["server-side-fallback-2026-06-01"],
    fallbacks: [{ model: FALLBACK_MODEL }],
    output_config: { effort: "medium", format: betaZodOutputFormat(BrandIntakeSchema) },
    system: SYSTEM,
    messages: [{ role: "user", content: buildIntakePrompt(site) }],
  });

  // Bill at the model that actually served the answer (a fallback turn
  // reports the fallback model here).
  await options.costSink?.(anthropicCostEntry(response.model, response.usage, "brand_intake", { brandId: options.brandId, ref: site.pages[0].url }));

  if (response.stop_reason === "refusal") throw new Error("intake: the model declined to extract this site");
  if (response.stop_reason === "max_tokens") throw new Error("intake: extraction was cut off (max_tokens)");
  if (!response.parsed_output) throw new Error("intake: response did not match the BrandIntake schema");

  const imageUrls = new Set([...site.pages.flatMap((p) => p.images.map((i) => i.src)), ...site.pages.flatMap((p) => p.icons)]);
  return normalizeIntake(response.parsed_output, { imageUrls });
};

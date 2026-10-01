import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BrandIntake } from "../brand/intake/schemas";
import { anthropicCostEntry, type CostSink } from "../cost/ledger";
import { type MascotConcept, MascotConceptsSchema } from "./schemas";

/**
 * Brand intake → N distinct mascot concepts for the customer to choose from
 * (plan decision 3: brief → candidates → pick). Text only and cheap; images
 * are generated for the concepts the customer likes, not for all of them.
 */

const DEFAULT_MODEL = "claude-opus-5-5";
const FALLBACK_MODEL = "claude-opus-4-8";

const SYSTEM = `You design brand mascots for Katalab. A brand's mascot appears in a short-form video (TikTok, Reels, Shorts) every day, for months, in the same niche. The thesis: brands become known by repeating the same character, topic and style every day, the way an app's mascot becomes the brand.

Design concepts that:
- are instantly recognizable as a silhouette and easy for an AI image/video model to keep on-model (simple shapes, few distinctive features, no fine patterns, no text or logos on the body);
- carry the brand's own colours (use the brand kit hex values) and meaning (the product name, its metaphor, its users);
- can plausibly act out viral short-form formats: talk to camera, react, point at things, hold a phone, show an app screen;
- differ from each other in form AND style, so the customer has a real choice.`;

export const buildConceptPrompt = (intake: BrandIntake, productIndex: number, count: number, direction?: string): string => {
  const product = intake.products[productIndex];
  const kit = intake.brandKit;
  return [
    `BRAND: ${intake.companyName} — ${intake.summary}`,
    `PRODUCT TO PROMOTE: ${product.name} (${product.type}) — ${product.oneLiner}`,
    `Features: ${product.features.join("; ")}`,
    `Audience: ${product.audience || intake.audience}`,
    `Tone: ${intake.tone.join(", ")}`,
    `Content language: ${intake.language}`,
    `Brand kit: primary ${kit.primaryColor ?? "?"}, secondary ${kit.secondaryColor ?? "?"}, accent ${kit.accentColor ?? "?"}, text ${kit.textColor ?? "?"}, background ${kit.backgroundColor ?? "?"}`,
    `Site evidence for the product: ${product.evidence}`,
    direction ? `\nDIRECTION FROM THE CUSTOMER: ${direction}` : "",
    `\nPropose exactly ${count} mascot concepts.`,
  ].join("\n");
};

export const generateMascotConcepts = async (
  intake: BrandIntake,
  options: { productIndex?: number; count?: number; direction?: string; costSink?: CostSink; model?: string; client?: Anthropic } = {},
): Promise<MascotConcept[]> => {
  const productIndex = options.productIndex ?? intake.recommendedProductIndex;
  if (!intake.products[productIndex]) throw new Error(`character: intake has no product at index ${productIndex}`);
  const model = options.model ?? process.env.CHARACTER_MODEL ?? DEFAULT_MODEL;
  const client = options.client ?? new Anthropic({ timeout: 180_000 });

  const response = await client.beta.messages.parse({
    model,
    max_tokens: 16_000,
    betas: ["server-side-fallback-2026-06-01"],
    fallbacks: [{ model: FALLBACK_MODEL }],
    output_config: { effort: "medium", format: betaZodOutputFormat(MascotConceptsSchema) },
    system: SYSTEM,
    messages: [{ role: "user", content: buildConceptPrompt(intake, productIndex, options.count ?? 5, options.direction) }],
  });
  await options.costSink?.(anthropicCostEntry(response.model, response.usage, "mascot_concepts"));

  if (response.stop_reason === "refusal") throw new Error("character: the model declined to propose concepts");
  if (!response.parsed_output) throw new Error("character: response did not match the concepts schema");
  return response.parsed_output.concepts;
};

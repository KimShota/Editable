import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BrandIntake } from "../brand/intake/schemas";
import type { LockedCharacter } from "../character/schemas";
import { anthropicCostEntry, type CostSink } from "../cost/ledger";
import { type Adaptation, AdaptationSchema, type AdaptedScript, type ProductFootage, type RecreationSpec } from "./schemas";

/**
 * RecreationSpec → AdaptedScript: the source video's skeleton (same lines,
 * same shots, same beats) rewritten for a brand's product and character.
 * Claude writes the words and says how each shot is made; `assembleScript`
 * holds it to the skeleton: one line per source line, one treatment per
 * source shot, requested lines verbatim, and product UI only from real
 * footage.
 */

const DEFAULT_MODEL = "claude-opus-5-5";
const FALLBACK_MODEL = "claude-opus-4-8";

export type AdaptOptions = {
  /** Source line indices to keep word for word (e.g. a hook that works as is). */
  keep?: number[];
  /** The comment keyword; Claude picks one when omitted. */
  cta?: string;
  /** Free-text direction from the operator. */
  direction?: string;
};

const fmt = (s: number) => s.toFixed(1);

export const buildAdaptText = (spec: RecreationSpec, intake: BrandIntake, character: LockedCharacter, footage: ProductFootage, opts: AdaptOptions = {}): string => {
  const product = intake.products[intake.recommendedProductIndex] ?? intake.products[0];
  const c = character.concept;
  const keep = new Set(opts.keep ?? []);
  const lines = spec.speech.lines
    .map((l, i) => `  [${i}] ${l.role} · ${l.wordCount} words · ${fmt(l.startSec)}s${keep.has(i) ? " · KEEP VERBATIM" : ""}: "${l.text}"`)
    .join("\n");
  const shots = spec.shots
    .map((s) => {
      const text = s.textOnScreen.map((t) => `${t.role} "${t.text}"`).join(", ");
      return `  ${s.id} ${fmt(s.startSec)}–${fmt(s.endSec)}s · ${s.kind} · ${s.framing} · ${s.speaker}: ${s.subject}${text ? ` · text: ${text}` : ""}`;
    })
    .join("\n");
  const beats = spec.structure.map((b) => `${b.beat}[${b.shotIndices.map((i) => `s${i}`).join(",")}]: ${b.purpose}`).join("\n  ");
  const clips = footage.clips.map((f) => `  ${f.id} (${fmt(f.endSec - f.startSec)}s): ${f.shows}`).join("\n");

  return [
    `SOURCE VIDEO (${spec.sourceId}, ${fmt(spec.media.durationSec)}s, ${spec.language}): ${spec.topic}`,
    `Why it works: ${spec.whyItWorks}`,
    `Beats:\n  ${beats}`,
    `Shots:\n${shots}`,
    `Spoken lines:\n${lines}`,
    `Captions: ${spec.captionStyle.mode}, ${spec.captionStyle.position}.`,
    ``,
    `BRAND: ${intake.companyName}. PRODUCT: ${product.name}: ${product.oneLiner}`,
    `Features (the only product facts you may state):\n${product.features.map((f) => `  - ${f}`).join("\n")}`,
    `Price and access: ${product.priceNote ?? "unknown"}`,
    `Audience: ${product.audience}. Brand tone: ${intake.tone.join(", ")}.`,
    ``,
    `CHARACTER: ${c.name}, ${c.form}. ${c.oneLine} Personality: ${c.personality.join("; ")}. Device: ${c.signatureProp}. Catchphrase: "${c.catchphrase}".`,
    ``,
    `PRODUCT FOOTAGE (real screen recordings; the ONLY way the product UI may appear):\n${clips}`,
    ``,
    `Rewrite this video for ${product.name}, presented by ${c.name}, in ${intake.language}.`,
    spec.speech.lines.length === 0
      ? `- The source has no spoken lines (music and on-screen text only): return an empty lines array. The words live in each shot's textOnScreen; rewrite those for ${product.name}, same roles and positions.`
      : `- Keep the skeleton: exactly one line per source line (indices 0-${spec.speech.lines.length - 1}), same role, close to the same word count, so the rhythm survives.`,
    `- Exactly one shot entry per source shot (${spec.shots.map((s) => s.id).join(", ")}), choosing how each is made. Talking shots become ${c.name} talking; screen shots show the product on its device using footageId, or a non-product screen via otherScreen.`,
    `- Keep the source's hook mechanism, pacing and CTA mechanism; swap the promise for what ${product.name} actually does.`,
    `- Mirror each source line's sentence shape, not just its length: an imperative step ("Go to X, look at Y") stays an imperative step a viewer could follow, a number reveal stays a reveal, an aside stays an aside.`,
    `- The payoff must answer the hook's stakes, not restate a feature. If the hook promises money or a goal, connect ${product.name} to reaching it (the hours it gives back go to the thing that earns), without promising earnings.`,
    `- Say "${product.name}" out loud at least once, early in the demo, the way the source names its tools.`,
    keep.size > 0 ? `- Lines marked KEEP VERBATIM must be copied exactly; make the next line bridge from them to the product naturally.` : "",
    opts.cta ? `- The comment keyword is "${opts.cta}".` : "",
    opts.direction ? `- Direction: ${opts.direction}` : "",
  ]
    .filter(Boolean)
    .join("\n");
};

export const adapt = async (
  spec: RecreationSpec,
  intake: BrandIntake,
  character: LockedCharacter,
  footage: ProductFootage,
  opts: AdaptOptions & { model?: string; client?: Anthropic; costSink?: CostSink; ref?: string } = {},
): Promise<{ adaptation: Adaptation; model: string }> => {
  const model = opts.model ?? process.env.RECREATION_MODEL ?? DEFAULT_MODEL;
  const client = opts.client ?? new Anthropic({ timeout: 300_000 });
  const response = await client.beta.messages.parse({
    model,
    max_tokens: 16_000,
    betas: ["server-side-fallback-2026-06-01"],
    fallbacks: [{ model: FALLBACK_MODEL }],
    output_config: { effort: "medium", format: betaZodOutputFormat(AdaptationSchema) },
    system:
      "You adapt viral short-form videos for a brand: same skeleton, the brand's product and recurring character. " +
      "Write like a creator speaks, not like an ad. State only product facts you are given: no invented numbers, results, customers or testimonials. " +
      "Never put the product's UI on screen except through a listed footage clip.",
    messages: [{ role: "user", content: buildAdaptText(spec, intake, character, footage, opts) }],
  });
  await opts.costSink?.(anthropicCostEntry(response.model, response.usage, "recreation_adapt", { ref: opts.ref }));
  if (response.stop_reason === "refusal") throw new Error("adapt: the model declined to adapt this video");
  if (response.stop_reason === "max_tokens") throw new Error("adapt: the script was cut off at max_tokens");
  if (!response.parsed_output) throw new Error("adapt: response did not match the adaptation schema");
  return { adaptation: response.parsed_output, model: response.model };
};

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * Holds the adaptation to the source skeleton. Strict: every source line and
 * shot answered exactly once, footage ids real. Kept lines are restored from
 * the source rather than trusted.
 */
export const assembleScript = (
  spec: RecreationSpec,
  a: Adaptation,
  footage: ProductFootage,
  meta: { brand: string; language: string; keep?: number[] },
  model: string,
): AdaptedScript => {
  const n = spec.speech.lines.length;
  const byIndex = new Map(a.lines.map((l) => [l.index, l]));
  const missingLines = spec.speech.lines.map((_, i) => i).filter((i) => !byIndex.has(i));
  if (missingLines.length > 0 || a.lines.length !== n) {
    throw new Error(`adapt: expected one line per source line (0-${n - 1}); missing ${missingLines.join(", ") || "none"}, got ${a.lines.length}`);
  }
  const byShot = new Map(a.shots.map((s) => [s.shotId, s]));
  const missingShots = spec.shots.filter((s) => !byShot.has(s.id)).map((s) => s.id);
  if (missingShots.length > 0 || a.shots.length !== spec.shots.length) {
    throw new Error(`adapt: expected one entry per source shot; missing ${missingShots.join(", ") || "none"}, got ${a.shots.length}`);
  }
  const clipIds = new Set(footage.clips.map((c) => c.id));
  for (const s of a.shots) {
    if (s.footageId !== null && !clipIds.has(s.footageId)) throw new Error(`adapt: ${s.shotId} uses unknown footage "${s.footageId}"`);
  }
  for (const i of meta.keep ?? []) {
    if (i < 0 || i >= n) throw new Error(`adapt: --keep ${i} is out of range (0-${n - 1})`);
  }
  const keep = new Set(meta.keep ?? []);

  return {
    sourceId: spec.sourceId,
    brand: meta.brand,
    language: meta.language,
    angle: a.angle,
    ctaKeyword: a.ctaKeyword,
    lines: spec.speech.lines.map((src, i) => {
      const text = keep.has(i) ? src.text : byIndex.get(i)!.text.trim();
      return {
        index: i,
        text,
        role: src.role,
        sourceText: src.text,
        kept: keep.has(i),
        shotIds: src.shotIds,
        wordCount: countWords(text),
        sourceWordCount: src.wordCount,
      };
    }),
    shots: spec.shots.map((src) => ({ ...byShot.get(src.id)!, sourceStartSec: src.startSec, sourceEndSec: src.endSec, sourceKind: src.kind })),
    postCaption: a.postCaption,
    hashtags: a.hashtags.map((h) => h.replace(/^#/, "")).slice(0, 5),
    createdAt: new Date().toISOString(),
    model,
  };
};

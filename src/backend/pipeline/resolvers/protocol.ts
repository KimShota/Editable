import { z } from "zod";
import { Word } from "../types";

/**
 * The provider contract for semantic anchor resolution. A provider reads
 * one block's transcript (already shifted to TRIMMED-clip time) and
 * locates the SPAN of each semantic anchor, honoring per-anchor search
 * windows (bounded upstream by literal anchors — the scaffolding).
 * Everything else — thresholds, snapping, clamping, fallbacks — lives
 * outside the provider, so every provider stays a thin "ask the model"
 * shim.
 */

/** One semantic anchor, with its window already resolved to numbers. */
export type SemanticQuery = {
  id: string;
  description: string;
  /** Light form constraint, e.g. "one sentence, starts with a verb". */
  form?: string;
  windowStartSec: number;
  windowEndSec: number;
};

export type ResolveBlockInput = {
  blockId: string;
  anchors: SemanticQuery[];
  /** Words in trimmed-clip time. */
  words: Word[];
  blockDurationSec: number;
};

export const RoleResolutionSchema = z.object({
  roleId: z.string(),
  /** Start of the word where the span begins, trimmed-clip seconds. */
  timeSec: z.number(),
  /** End of the word where the span ends. */
  endSec: z.number(),
  /** 0..1; 0 = could not find the moment. */
  confidence: z.number(),
  /** The exact transcript words anchored to. */
  quote: z.string().optional(),
});

/** Root object shape (structured outputs require an object root). */
export const ResolutionsSchema = z.object({
  resolutions: z.array(RoleResolutionSchema),
});

export type RoleResolution = z.infer<typeof RoleResolutionSchema>;

export type RoleResolver = {
  name: string;
  resolveBlock: (input: ResolveBlockInput) => Promise<RoleResolution[]>;
};

/** Prompt shared by every LLM provider, so behavior differs only by transport. */
export const buildPrompt = (input: ResolveBlockInput): string => {
  const wordLines = input.words
    .map((w) => `${w.startSec.toFixed(2)}-${w.endSec.toFixed(2)} ${JSON.stringify(w.text)}`)
    .join("\n");
  const anchorLines = input.anchors
    .map((a) => {
      const parts = [`- anchorId ${JSON.stringify(a.id)}: ${a.description}`];
      if (a.form) parts.push(`  Expected form: ${a.form}.`);
      parts.push(
        `  This moment lies between ${a.windowStartSec.toFixed(2)}s and ${a.windowEndSec.toFixed(2)}s.`,
      );
      return parts.join("\n");
    })
    .join("\n");

  return `You are locating structural moments ("anchors") in one block of a short-form video, using the block's transcript.

Transcript — one word per line, formatted as: start_time-end_time "word"
${wordLines}

The block is ${input.blockDurationSec.toFixed(2)} seconds long.

Anchors to locate — each is a SPAN of speech (it may be a single word or several sentences):
${anchorLines}

For each anchor, determine where in this specific speech the moment occurs. The speakers phrase things differently every time — match the MEANING of the description, not literal keywords. Respect each anchor's stated time bounds: the answer lies inside them.

Return a JSON object of the shape:
{"resolutions": [{"roleId": "<anchorId>", "timeSec": <start time of the span's first word>, "endSec": <end time of the span's last word>, "confidence": <0..1>, "quote": "<the exact word(s) the span covers, abbreviated if long>"}]}

Include every anchor exactly once. If you cannot find an anchor in this transcript, return it with confidence 0. Respond with ONLY the JSON object, no other text.`;
};

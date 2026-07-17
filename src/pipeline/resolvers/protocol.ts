import { z } from "zod";
import { Role, Word } from "../types";

/**
 * The provider contract for role resolution. A provider reads one block's
 * transcript (already shifted to TRIMMED-clip time) and locates each role.
 * Everything else — thresholds, snapping, fallbacks — lives outside the
 * provider, so every provider stays a thin "ask the model" shim.
 */

export type ResolveBlockInput = {
  blockId: string;
  roles: Role[];
  /** Words in trimmed-clip time. */
  words: Word[];
  blockDurationSec: number;
};

export const RoleResolutionSchema = z.object({
  roleId: z.string(),
  /** Start of the word where the role begins, trimmed-clip seconds. */
  timeSec: z.number(),
  /** 0..1; 0 = could not find the role. */
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
    .map((w) => `${w.startSec.toFixed(2)} ${JSON.stringify(w.text)}`)
    .join("\n");
  const roleLines = input.roles
    .map((r) => `- roleId ${JSON.stringify(r.id)}: ${r.description}`)
    .join("\n");

  return `You are locating structural moments ("roles") in one block of a short-form video, using the block's transcript.

Transcript — one word per line, formatted as: start_time_in_seconds "word"
${wordLines}

The block is ${input.blockDurationSec.toFixed(2)} seconds long.

Roles to locate:
${roleLines}

For each role, determine where in this specific speech the role occurs. The speakers phrase things differently every time — match the MEANING of the role description, not literal keywords.

Return a JSON object of the shape:
{"resolutions": [{"roleId": "...", "timeSec": <start time in seconds of the word where the role begins>, "confidence": <0..1>, "quote": "<the exact word(s) you anchored to>"}]}

Include every role exactly once. If you cannot find a role in this transcript, return it with confidence 0. Respond with ONLY the JSON object, no other text.`;
};

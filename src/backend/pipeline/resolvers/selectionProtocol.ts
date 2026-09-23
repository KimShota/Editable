import { z } from "zod";

/**
 * The provider contract for retake/false-start selection (select.ts). A
 * provider reads one block's own candidate utterances (already segmented
 * by silence, independently transcribed) plus the slot's filming
 * instructions, and returns a keep/drop verdict per utterance. Mirrors
 * correctionProtocol.ts's shape exactly (query type, Zod schema, prompt
 * builder, provider type) so the two stay easy to compare; kept as a
 * separate module rather than folded into correctionProtocol.ts since the
 * two ask fundamentally different questions (word-level spelling fix vs.
 * utterance-level keep/drop) and evolve independently.
 */

export type SelectionUtteranceQuery = { id: string; text: string };

export type SelectionQuery = {
  blockId: string;
  /** The video slot's own filming instructions — the yardstick a verdict
   *  measures each utterance against, same role trim.ts's filler judgment
   *  already gives its own resolver. */
  instructions: string;
  /** In the order they were spoken. */
  utterances: SelectionUtteranceQuery[];
};

export const SelectionVerdictSchema = z.object({
  id: z.string(),
  keep: z.boolean(),
  reason: z.string(),
  /** 0..1; 0 = no real opinion. Below SELECT_CONFIDENCE_THRESHOLD (select.ts)
   *  the heuristic's own verdict for this utterance stands instead. */
  confidence: z.number(),
});

export const SelectionsSchema = z.object({
  verdicts: z.array(SelectionVerdictSchema),
});

export type SelectionVerdict = z.infer<typeof SelectionVerdictSchema>;

export type SelectionResolver = {
  name: string;
  selectBlock: (input: SelectionQuery) => Promise<SelectionVerdict[]>;
};

/** Prompt shared by every LLM provider, so behavior differs only by transport. */
export const buildSelectionPrompt = (input: SelectionQuery): string => {
  const lines = input.utterances
    .map((u, i) => `${i}. id=${JSON.stringify(u.id)}: ${JSON.stringify(u.text)}`)
    .join("\n");

  return `A creator filmed one take for a video block. Filming instructions given to them: "${input.instructions}"

The recording's audio was split into separate spoken utterances (by pauses), in the order they were actually said:
${lines}

Some utterances may be: a RETAKE of an earlier one (the same line, said again — when this happens, keep only the BEST one, usually the LATEST, since people warm up into a delivery), a FALSE START that was abandoned and completed later (drop the false start, keep the completed version), FILLER/an aside not really part of the ask ("okay, um, let me try that again", a stray "wait" or "hold on"), or genuinely DISTINCT content that should all survive (e.g. two different sentences that happen to share some words, or two separate takes that together make up ONE line — like the marker phrase filmed separately from the body of the explanation).

For EACH utterance, decide whether it should be KEPT in the final edit. Judge by MEANING and content, not surface wording — two utterances can be a retake of each other even if phrased slightly differently. Never mark a distinct, real sentence as a retake just because it shares a few words with another.

Return a JSON object: {"verdicts": [{"id": "<utterance id>", "keep": <bool>, "reason": "<short reason>", "confidence": <0..1>}, ...]}. Include every utterance exactly once, in any order. Respond with ONLY the JSON object, no other text.`;
};

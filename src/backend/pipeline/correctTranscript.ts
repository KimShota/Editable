import { FilledFormat, Transcript } from "./types";
import { pickCorrector, ResolverChoice } from "./resolvers";
import { alignToScript } from "./alignToScript";

/**
 * Module 3b — Transcript correction (runs right after transcribe).
 *
 * Two passes, in order:
 *
 * 1. alignToScript.ts — deterministic, no LLM, always runs when the job
 *    has a script.json (the resources wizard's "Write your lines" step):
 *    aligns whisper's words against the user's own typed line and swaps
 *    in the script's spelling wherever the two clearly refer to the same
 *    word (e.g. a mistranscribed name). Ground truth the pipeline already
 *    has, at zero marginal cost.
 *
 * 2. The LLM lexicon pass below (optional, needs `lexicon` + a resolver):
 *    whisper.cpp's base.en model reliably mishears proper nouns and
 *    domain terms it has no reason to expect ("Claude" → "clot"/"cloud",
 *    "5 secret codes" → "5 secret cloak coats"). Since the hook title,
 *    every code's captured name, and every burned-in caption all derive
 *    from this one transcript, one bad word here fans out across the
 *    whole video.
 *
 *    Each block's words go to the model indexed, alongside the job's
 *    `lexicon` (the vocabulary this specific video's creator knows it
 *    will use — the format itself is reused across niches/tools, so this
 *    is job content, not format structure), and the model returns ONLY
 *    the indices it's confident were mistranscribed. Corrections are
 *    strict 1:1 word swaps — never merges/splits/reorders — so every
 *    timestamp downstream stays exactly as whisper produced it; only
 *    `text` changes. Jobs without a `lexicon`, or a run with no resolver
 *    available, skip this pass — it's pure upside when configured, never
 *    a hard dependency.
 */
export const correctTranscript = async (
  filled: FilledFormat,
  rawTranscript: Transcript,
  choice: ResolverChoice = "auto",
): Promise<Transcript> => {
  const transcript = alignToScript(filled.jobDir, rawTranscript);

  const lexicon = filled.lexicon ?? [];
  if (lexicon.length === 0) return transcript;

  const corrector = pickCorrector(choice);
  if (!corrector) return transcript;

  const blocks = await Promise.all(
    transcript.blocks.map(async (block) => {
      const takes = await Promise.all(
        block.takes.map(async (words) => {
          if (words.length === 0) return words;
          try {
            const corrections = await corrector.correctBlock({
              blockId: block.blockId,
              words,
              lexicon,
            });
            if (corrections.length === 0) return words;
            const next = [...words];
            for (const c of corrections) {
              if (c.index < next.length) {
                next[c.index] = { ...next[c.index], text: c.text };
              }
            }
            return next;
          } catch (err) {
            console.warn(
              `correctTranscript: ${corrector.name} failed on block "${block.blockId}" (${(err as Error).message}) — using raw transcript`,
            );
            return words;
          }
        }),
      );
      return { ...block, takes };
    }),
  );

  return { blocks };
};

import { z } from "zod";
import { Word } from "../types";

/**
 * The provider contract for transcript correction. A provider reads one
 * block's raw whisper words (indexed) plus the format's lexicon, and
 * returns ONLY the indices it's confident were mistranscribed. Corrections
 * are 1:1 word swaps — never merges, splits, or reorders — so timestamps
 * stay valid without the corrector needing to know about timing at all.
 */

export type CorrectionQuery = {
  blockId: string;
  words: Word[];
  lexicon: string[];
};

export const WordCorrectionSchema = z.object({
  index: z.number().int().min(0),
  text: z.string().min(1),
});

export const CorrectionsSchema = z.object({
  corrections: z.array(WordCorrectionSchema),
});

export type WordCorrection = z.infer<typeof WordCorrectionSchema>;

export type TranscriptCorrector = {
  name: string;
  correctBlock: (input: CorrectionQuery) => Promise<WordCorrection[]>;
};

/** Prompt shared by every LLM provider, so behavior differs only by transport. */
export const buildCorrectionPrompt = (input: CorrectionQuery): string => {
  const wordLines = input.words.map((w, i) => `${i}: ${JSON.stringify(w.text)}`).join("\n");
  const lexiconLine =
    input.lexicon.length > 0
      ? `Vocabulary this video is expected to use, which a generic speech model commonly mishears as similar-sounding ordinary words: ${input.lexicon.join(", ")}.\n\n`
      : "";

  return `A speech-to-text model (Whisper) transcribed one clip of a short-form video, one word per line, indexed from 0. It occasionally mishears a proper noun, brand name, or domain term as an ordinary word that sounds similar.

${lexiconLine}Transcript:
${wordLines}

Find words that were misheard and need correcting. Only flag genuine transcription errors — never the speaker's grammar, filler words ("um", "like"), or true disfluencies, and never a word that's merely an unusual but correct choice. Each correction replaces exactly ONE indexed word with corrected text; if a mistranscribed multi-word term was split across several indices, correct each index separately rather than merging them.

Return a JSON object: {"corrections": [{"index": <int>, "text": "<corrected word>"}]}. Include only words that need changing — if none do, return {"corrections": []}. Respond with ONLY the JSON object, no other text.`;
};

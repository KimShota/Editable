import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ScriptSuggestionSchema } from "../content/schemas";
import { Transcript, Word } from "./types";

/**
 * Deterministic transcript correction against the user's OWN typed script
 * (jobs/<id>/script.json, written by the resources wizard's "Write your
 * lines" step) — the ground truth for what they meant to say, available
 * whether or not the job set a `lexicon` (correctTranscript.ts's LLM pass
 * is opt-in per job; this needs no opt-in and no API call at all).
 *
 * Whisper reliably mishears a name it has no reason to expect — "Shota"
 * transcribed as "Shoda" is exactly this, and it shipped straight through
 * to the biggest text in the video (a bigTitle caption) despite the
 * user's own script.json holding the correct spelling right next to it.
 * "AI reel editor" → "AI real editor" is the same failure on a common
 * word landing in an unusual construction.
 *
 * Method: word-sequence alignment (Needleman-Wunsch on WORDS, not
 * characters — insertions/deletions from ad-libbing are expected and must
 * not derail the alignment) between whisper's words and the script line's
 * own words, using per-word similarity (normalized Levenshtein) as the
 * match score. Only 1:1 aligned pairs above a similarity floor get
 * corrected; everything else (real ad-libs, words the script never
 * mentions) is left as whisper produced it. Timestamps are NEVER touched
 * — only `text`.
 */

const normalize = (w: string): string => w.toLowerCase().replace(/[^a-z0-9']/g, "");

const levenshtein = (a: string, b: string): number => {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
};

/** 1.0 = identical (after normalizing case/punctuation), 0.0 = nothing in
 *  common — normalized edit distance over the longer word's length.
 *  Exported for prepareTake.ts's own word-sequence alignment (ordering
 *  multiple speaking-take clips against the script), the same scoring this
 *  module already uses for transcript correction. */
export const wordSimilarity = (a: string, b: string): number => {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length === 0 && nb.length === 0) return 1;
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1;
  return 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
};

type AlignedPair = { transcriptIndex: number; scriptIndex: number };

const GAP_PENALTY = -0.4;

/** Global (Needleman-Wunsch) alignment of whisper's words against the
 *  script's own words — a gap on either side (an ad-lib whisper heard
 *  that isn't in the script, or a script word never actually said) costs
 *  GAP_PENALTY; a substitution scores by wordSimilarity. Returns only the
 *  1:1 matched pairs, in order. */
const alignWordSequences = (transcriptWords: string[], scriptWords: string[]): AlignedPair[] => {
  const n = transcriptWords.length;
  const m = scriptWords.length;
  if (n === 0 || m === 0) return [];

  const score: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) score[i][0] = score[i - 1][0] + GAP_PENALTY;
  for (let j = 1; j <= m; j++) score[0][j] = score[0][j - 1] + GAP_PENALTY;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const matchScore = score[i - 1][j - 1] + wordSimilarity(transcriptWords[i - 1], scriptWords[j - 1]);
      const skipTranscript = score[i - 1][j] + GAP_PENALTY;
      const skipScript = score[i][j - 1] + GAP_PENALTY;
      score[i][j] = Math.max(matchScore, skipTranscript, skipScript);
    }
  }

  const pairs: AlignedPair[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const matchScore = score[i - 1][j - 1] + wordSimilarity(transcriptWords[i - 1], scriptWords[j - 1]);
    if (score[i][j] === matchScore) {
      pairs.push({ transcriptIndex: i - 1, scriptIndex: j - 1 });
      i--;
      j--;
    } else if (score[i][j] === score[i - 1][j] + GAP_PENALTY) {
      i--;
    } else {
      j--;
    }
  }
  return pairs.reverse();
};

const SIMILARITY_FLOOR = 0.5;

/** Aligns and corrects ONE take's words against one script line's text —
 *  the per-block/per-take unit correctTranscript.ts's block loop applies
 *  this to. */
const alignTake = (words: Word[], scriptText: string): Word[] => {
  const scriptWords = scriptText.split(/\s+/).filter(Boolean);
  if (scriptWords.length === 0) return words;

  const pairs = alignWordSequences(
    words.map((w) => w.text),
    scriptWords,
  );

  const next = [...words];
  for (const { transcriptIndex, scriptIndex } of pairs) {
    const similarity = wordSimilarity(words[transcriptIndex].text, scriptWords[scriptIndex]);
    if (similarity < SIMILARITY_FLOOR) continue; // real ad-lib or coincidental gap — leave whisper's word as-is
    if (normalize(words[transcriptIndex].text) === normalize(scriptWords[scriptIndex])) continue; // already correct
    next[transcriptIndex] = { ...next[transcriptIndex], text: scriptWords[scriptIndex] };
  }
  return next;
};

/** jobs/<id>/script.json's suggestions, keyed by blockId — exported for
 *  splitTake.ts's own use (backdating a mid-sentence marker to the line's
 *  real start), not just this module's own transcript correction. */
export const readScriptSuggestions = (jobDir: string): Map<string, string> | undefined => {
  const file = path.join(jobDir, "script.json");
  if (!fs.existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const parsed = z.object({ suggestions: ScriptSuggestionSchema.shape.suggestions }).safeParse(raw);
  if (!parsed.success) return undefined;
  const byBlockId = new Map<string, string>();
  for (const s of parsed.data.suggestions) byBlockId.set(s.blockId, s.text);
  return byBlockId;
};

/** Corrects every block's transcript against jobs/<id>/script.json, when
 *  one exists — a no-op (returns `transcript` unchanged) if the job has
 *  no script.json, or a block has no matching suggestion. */
export const alignToScript = (jobDir: string, transcript: Transcript): Transcript => {
  const scriptByBlockId = readScriptSuggestions(jobDir);
  if (!scriptByBlockId || scriptByBlockId.size === 0) return transcript;

  return {
    blocks: transcript.blocks.map((block) => {
      const scriptText = scriptByBlockId.get(block.blockId);
      if (!scriptText) return block;
      return { ...block, takes: block.takes.map((words) => alignTake(words, scriptText)) };
    }),
  };
};

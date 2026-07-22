import { Block, LiteralAnchor, Word } from "./types";

/**
 * Literal anchor matching — no LLM.
 * The instruction told the user to say fixed words ("First is …"); finding
 * them in the transcript is plain fuzzy text matching, which makes literal
 * anchors near-certain block markers. When the anchor captures, the words
 * the user speaks right after the phrase (their own name for the item) are
 * collected up to the next pause, sentence break, fixed continuation
 * (`captureUntil`), or a hard word cap — and returned as content.
 *
 * All times are TRIMMED-clip seconds (words arrive already trim-shifted).
 */

/** Mean per-word similarity a window must reach to count as the phrase. */
const MIN_SIMILARITY = 0.72;
/** A speech gap this long ends a capture. */
const CAPTURE_GAP_SEC = 0.35;
const MAX_CAPTURE_WORDS = 8;

/** Whisper writes digits; instructions write words (and vice versa). */
const NUMBER_WORDS: Record<string, string> = {
  "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
  "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine",
  "10": "ten", "1st": "first", "2nd": "second", "3rd": "third",
  "4th": "fourth", "5th": "fifth",
};

const normalize = (raw: string): string => {
  const bare = raw.toLowerCase().replace(/[^a-z0-9']/g, "");
  return NUMBER_WORDS[bare] ?? bare;
};

const levenshtein = (a: string, b: string): number => {
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = cur;
    }
  }
  return prev[b.length];
};

const similarity = (a: string, b: string): number => {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
};

const tokenize = (phrase: string): string[] =>
  phrase.split(/\s+/).map(normalize).filter((t) => t.length > 0);

/** Mean similarity of the phrase against the window starting at `at`. */
const windowScore = (words: Word[], at: number, tokens: string[]): number => {
  if (at + tokens.length > words.length) return 0;
  let total = 0;
  for (let k = 0; k < tokens.length; k++) {
    total += similarity(normalize(words[at + k].text), tokens[k]);
  }
  return total / tokens.length;
};

/** Index of the earliest window matching the phrase, or -1. */
const findPhrase = (words: Word[], tokens: string[]): number => {
  for (let i = 0; i + tokens.length <= words.length; i++) {
    if (windowScore(words, i, tokens) >= MIN_SIMILARITY) return i;
  }
  return -1;
};

const endsWithSentenceBreak = (raw: string): boolean => /[.!?]["']?$/.test(raw.trim());

/** Strip stray punctuation from the edges of a captured word. */
const cleanCaptured = (raw: string): string =>
  raw.trim().replace(/^["'([{]+/, "").replace(/[.,!?;:"')\]}]+$/, "");

export type LiteralMatch = {
  /** Start of the phrase's first word. */
  startSec: number;
  /** End of the capture's last word (or the phrase's, if no capture). */
  endSec: number;
  /** Start of the first captured word (capture anchors only). */
  captureStartSec?: number;
  confidence: number;
  /** The transcript words matched (phrase + capture) — for inspection. */
  quote: string;
  capturedText?: string;
};

/** Best-scoring phrasing that actually occurs in `words`, or null if none
 *  of the accepted phrasings match anywhere. Ties (equal confidence) prefer
 *  whichever occurs earliest, matching a single-phrase anchor's old
 *  behavior of finding the earliest occurrence. */
const findBestPhrasing = (
  phrases: string[],
  words: Word[],
): { at: number; tokens: string[]; confidence: number } | null => {
  let best: { at: number; tokens: string[]; confidence: number } | null = null;
  for (const phrase of phrases) {
    const tokens = tokenize(phrase);
    if (tokens.length === 0) continue;
    const at = findPhrase(words, tokens);
    if (at === -1) continue;
    const confidence = windowScore(words, at, tokens);
    if (!best || confidence > best.confidence || (confidence === best.confidence && at < best.at)) {
      best = { at, tokens, confidence };
    }
  }
  return best;
};

export const matchLiteralAnchor = (
  anchor: LiteralAnchor,
  words: Word[],
): LiteralMatch | null => {
  const found = findBestPhrasing(anchor.phrases, words);
  if (!found) return null;
  const { at, tokens, confidence } = found;

  const phraseWords = words.slice(at, at + tokens.length);
  let last = at + tokens.length - 1;
  const captured: Word[] = [];

  if (anchor.capture) {
    const untilTokens = anchor.captureUntil ? tokenize(anchor.captureUntil) : null;
    for (let j = at + tokens.length; j < words.length; j++) {
      if (captured.length >= MAX_CAPTURE_WORDS) break;
      if (untilTokens && windowScore(words, j, untilTokens) >= MIN_SIMILARITY) break;
      const prev = words[j - 1];
      if (captured.length > 0 && endsWithSentenceBreak(prev.text)) break;
      if (words[j].startSec - prev.endSec > CAPTURE_GAP_SEC) break;
      captured.push(words[j]);
      last = j;
      if (endsWithSentenceBreak(words[j].text)) break;
    }
    if (captured.length === 0) return null;
  }

  return {
    startSec: phraseWords[0].startSec,
    endSec: words[last].endSec,
    captureStartSec: captured.length > 0 ? captured[0].startSec : undefined,
    confidence,
    quote: words.slice(at, last + 1).map((w) => w.text).join(" "),
    capturedText: anchor.capture
      ? captured.map((w) => cleanCaptured(w.text)).filter((t) => t.length > 0).join(" ")
      : undefined,
  };
};

/**
 * Decides playback order for a voice block's takes when the user films the
 * marker line ("First is …") and the body of the explanation as separate
 * clips instead of one continuous take. No LLM: the block's first literal
 * anchor is its opening marker by convention, so whichever take matches it
 * best is moved to the front; every other take keeps its relative upload
 * order (the order the user filmed/dropped them in — the honest default
 * when there's nothing else to go on).
 *
 * Returns a permutation of upload indices (0..rawTakes.length-1) in
 * playback order. A single take, or a block with no literal anchor to
 * match against, returns upload order unchanged.
 */
export const orderTakes = (block: Block, rawTakes: Word[][]): number[] => {
  const uploadOrder = rawTakes.map((_, i) => i);
  if (rawTakes.length <= 1) return uploadOrder;

  const marker = [...block.roles, ...block.anchors].find(
    (a): a is LiteralAnchor => a.kind === "literal",
  );
  if (!marker) return uploadOrder;

  let markerTakeIdx = -1;
  let bestConfidence = 0;
  rawTakes.forEach((words, i) => {
    const match = words.length > 0 ? matchLiteralAnchor(marker, words) : null;
    if (match && match.confidence > bestConfidence) {
      bestConfidence = match.confidence;
      markerTakeIdx = i;
    }
  });

  if (markerTakeIdx <= 0) return uploadOrder; // not found, or already first
  return [markerTakeIdx, ...uploadOrder.filter((i) => i !== markerTakeIdx)];
};

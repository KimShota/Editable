import { LiteralAnchor, Word } from "./types";

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

export const matchLiteralAnchor = (
  anchor: LiteralAnchor,
  words: Word[],
): LiteralMatch | null => {
  const tokens = tokenize(anchor.phrase);
  if (tokens.length === 0) return null;
  const at = findPhrase(words, tokens);
  if (at === -1) return null;

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
    confidence: windowScore(words, at, tokens),
    quote: words.slice(at, last + 1).map((w) => w.text).join(" "),
    capturedText: anchor.capture
      ? captured.map((w) => cleanCaptured(w.text)).filter((t) => t.length > 0).join(" ")
      : undefined,
  };
};

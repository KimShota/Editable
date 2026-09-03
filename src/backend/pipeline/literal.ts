import { Block, LiteralAnchor, Word } from "./types";
import { tokenizeWords } from "./tokenize";
import { containsCjk } from "../components/cjk";

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

/** Unicode-aware (`\p{L}\p{N}`, not `a-z0-9`) so a Japanese/CJK marker
 *  phrase survives this strip instead of being deleted to "" — an
 *  ASCII-only regex here made `similarity` below score every Japanese
 *  token pair as vacuously identical, so a marker like "次は" could never
 *  actually be found in the transcript. */
const normalize = (raw: string): string => {
  const bare = raw.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
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
  tokenizeWords(phrase).map(normalize).filter((t) => t.length > 0);

/** How many EXTRA (or fewer) whisper "word" segments a CJK phrase's own
 *  matched span may span relative to its character count. Whisper's
 *  Japanese/Chinese segmentation doesn't reliably give one word per
 *  phrase character the way it gives one word per Latin word — a
 *  3-character marker might come back as anywhere from 1 to several
 *  whisper segments — so a fixed tokens.length-word window (ordinary
 *  windowScore's assumption, correct for Latin) can miss a real match
 *  entirely for a CJK phrase. */
const CJK_WINDOW_SLACK = 2;

/** Mean similarity of the phrase against the window starting at `at` —
 *  ordinary Latin-phrase matching, one whisper word per phrase token. */
const windowScore = (words: Word[], at: number, tokens: string[]): number => {
  if (at + tokens.length > words.length) return 0;
  let total = 0;
  for (let k = 0; k < tokens.length; k++) {
    total += similarity(normalize(words[at + k].text), tokens[k]);
  }
  return total / tokens.length;
};

/** Best-scoring window length (and score) for a CJK phrase starting at
 *  `at`, trying every plausible number of whisper words the phrase's
 *  characters could have been split across (see CJK_WINDOW_SLACK).
 *  Compares the WHOLE concatenated span against the whole phrase
 *  (character-level Levenshtein) rather than token-by-token — the two
 *  granularities don't line up 1:1 the way Latin words vs. whisper words
 *  normally do. */
const bestCjkWindow = (words: Word[], at: number, tokens: string[]): { length: number; score: number } => {
  const target = tokens.join("");
  const minLen = Math.max(1, tokens.length - CJK_WINDOW_SLACK);
  const maxLen = tokens.length + CJK_WINDOW_SLACK;
  let best = { length: tokens.length, score: 0 };
  for (let len = minLen; at + len <= words.length && len <= maxLen; len++) {
    const candidate = words
      .slice(at, at + len)
      .map((w) => normalize(w.text))
      .join("");
    const score = similarity(candidate, target);
    if (score > best.score) best = { length: len, score };
  }
  return best;
};

/** Dispatches to bestCjkWindow (variable-length, whole-string comparison)
 *  for a CJK phrase, or the ordinary fixed-length windowScore otherwise —
 *  the single place every phrase/window match in this module goes
 *  through, so a `captureUntil` continuation phrase gets the same
 *  CJK-aware treatment as a marker phrase. */
const matchAt = (words: Word[], at: number, tokens: string[], isCjkPhrase: boolean): { length: number; score: number } =>
  isCjkPhrase ? bestCjkWindow(words, at, tokens) : { length: tokens.length, score: windowScore(words, at, tokens) };

/** Earliest window matching the phrase (position + how many whisper words
 *  it actually spans), or null. */
const findPhrase = (words: Word[], tokens: string[], isCjkPhrase: boolean): { at: number; length: number } | null => {
  for (let i = 0; i < words.length; i++) {
    const { length, score } = matchAt(words, i, tokens, isCjkPhrase);
    if (score >= MIN_SIMILARITY) return { at: i, length };
  }
  return null;
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
  /** End of the matched PHRASE itself, ignoring any capture — stable
   *  regardless of how far a greedy capture happened to run. Callers that
   *  need "where does this marker end" for anything other than displaying
   *  the captured text (e.g. splitTake.ts locating the next block's search
   *  floor) must use this, not `endSec`: a capture's length depends on
   *  speech-gap/sentence-break luck, not on the marker's own position, and
   *  treating it as a boundary lets a greedy capture consume the next
   *  block's opening words. */
  phraseEndSec: number;
  /** Start of the first captured word (capture anchors only). */
  captureStartSec?: number;
  confidence: number;
  /** The transcript words matched (phrase + capture) — for inspection. */
  quote: string;
  capturedText?: string;
};

type Phrasing = { at: number; matchedLength: number; confidence: number };

/** Every accepted phrasing that occurs in `words`, best first: highest
 *  confidence, then earliest occurrence, then the order they were listed
 *  in the format — the same preference a single best-match pick used to
 *  apply, just kept as a ranked list so a phrasing that turns out to be
 *  unusable can fall through to the next one. */
const findPhrasings = (phrases: string[], words: Word[]): Phrasing[] => {
  const found: Phrasing[] = [];
  for (const phrase of phrases) {
    const tokens = tokenize(phrase);
    if (tokens.length === 0) continue;
    const isCjkPhrase = containsCjk(phrase);
    const match = findPhrase(words, tokens, isCjkPhrase);
    if (!match) continue;
    const { score } = matchAt(words, match.at, tokens, isCjkPhrase);
    found.push({ at: match.at, matchedLength: match.length, confidence: score });
  }
  return found.sort((a, b) => b.confidence - a.confidence || a.at - b.at);
};

/** Words spoken after the phrase, up to the next pause, sentence break,
 *  `captureUntil` continuation, or the hard word cap. */
const collectCapture = (words: Word[], from: number, untilTokens: string[] | null, untilIsCjk: boolean): Word[] => {
  const captured: Word[] = [];
  for (let j = from; j < words.length; j++) {
    if (captured.length >= MAX_CAPTURE_WORDS) break;
    if (untilTokens && matchAt(words, j, untilTokens, untilIsCjk).score >= MIN_SIMILARITY) break;
    const prev = words[j - 1];
    if (captured.length > 0 && endsWithSentenceBreak(prev.text)) break;
    if (words[j].startSec - prev.endSec > CAPTURE_GAP_SEC) break;
    captured.push(words[j]);
    if (endsWithSentenceBreak(words[j].text)) break;
  }
  return captured;
};

export const matchLiteralAnchor = (
  anchor: LiteralAnchor,
  words: Word[],
): LiteralMatch | null => {
  const untilTokens = anchor.captureUntil ? tokenize(anchor.captureUntil) : null;
  const untilIsCjk = anchor.captureUntil ? containsCjk(anchor.captureUntil) : false;

  for (const { at, matchedLength, confidence } of findPhrasings(anchor.phrases, words)) {
    const captured = anchor.capture ? collectCapture(words, at + matchedLength, untilTokens, untilIsCjk) : [];

    // A capture anchor's phrases are meant to be the FIXED marker only, but
    // an authored format can list a variant that also spells out the
    // variable words ("For research" alongside "For", when "research" is
    // exactly what should be captured). That variant consumes the content
    // and leaves nothing behind — so fall through to the next-best phrasing
    // instead of failing the anchor outright, which would silently drop
    // every overlay timed off it.
    if (anchor.capture && captured.length === 0) continue;

    const last = at + matchedLength - 1 + captured.length;
    return {
      startSec: words[at].startSec,
      endSec: words[last].endSec,
      phraseEndSec: words[at + matchedLength - 1].endSec,
      captureStartSec: captured.length > 0 ? captured[0].startSec : undefined,
      confidence,
      quote: words.slice(at, last + 1).map((w) => w.text).join(" "),
      capturedText: anchor.capture
        ? captured.map((w) => cleanCaptured(w.text)).filter((t) => t.length > 0).join(" ")
        : undefined,
    };
  }

  return null;
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

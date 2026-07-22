import { AnchoredTime, TakeTrim, Word } from "./types";

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** Shift raw-clip words into trimmed-clip time and clamp to the block,
 *  dropping any word entirely outside it — used where only what actually
 *  PLAYS matters (burning captions: a word trim.ts cut from the visible
 *  clip must not show up as a caption for footage that isn't there). */
export const toTrimmedWords = (
  words: Word[],
  srcInSec: number,
  blockDurationSec: number,
): Word[] =>
  words
    .map((w) => ({
      text: w.text,
      startSec: clamp(w.startSec - srcInSec, 0, blockDurationSec),
      endSec: clamp(w.endSec - srcInSec, 0, blockDurationSec),
    }))
    .filter((w) => w.endSec > 0 && w.startSec < blockDurationSec);

/** Same shift-and-clamp, but keeps every word instead of dropping ones
 *  outside the trim window — a word ASR mistimed into a padding/dead-air
 *  region trim.ts cut from PLAYBACK is still real, spoken content, and
 *  anchor matching needs to find it even though it won't be shown. Words
 *  outside the window collapse to the nearest edge (start or end = 0 or
 *  blockDurationSec), so they still contribute their TEXT to phrase
 *  matching without claiming a false position on the visible timeline. */
const toClampedWords = (
  words: Word[],
  srcInSec: number,
  blockDurationSec: number,
): Word[] =>
  words.map((w) => ({
    text: w.text,
    startSec: clamp(w.startSec - srcInSec, 0, blockDurationSec),
    endSec: clamp(w.endSec - srcInSec, 0, blockDurationSec),
  }));

const concatenateTakesWith = (
  rawTakes: Word[][],
  takeTrims: TakeTrim[],
  mapWords: (words: Word[], srcInSec: number, blockDurationSec: number) => Word[],
): { words: Word[]; blockDurationSec: number } => {
  let cursor = 0;
  const words: Word[] = [];
  for (let i = 0; i < takeTrims.length; i++) {
    const { srcInSec, srcOutSec } = takeTrims[i];
    const durationSec = srcOutSec - srcInSec;
    const shifted = mapWords(rawTakes[i] ?? [], srcInSec, durationSec).map((w) => ({
      text: w.text,
      startSec: w.startSec + cursor,
      endSec: w.endSec + cursor,
    }));
    words.push(...shifted);
    cursor += durationSec;
  }
  return { words, blockDurationSec: cursor };
};

/**
 * Concatenates a block's takes (each in its OWN raw-clip time) into one
 * word list in TRIMMED BLOCK time, exactly as if they'd always been a
 * single clip — this is what lets resolveRoles/assemble treat a multi-take
 * block identically to a single-take one downstream: they only ever see
 * `words` + `blockDurationSec`, never how many files it came from.
 *
 * Use this for anything that renders onto the visible clip (captions).
 */
export const concatenateTakes = (
  rawTakes: Word[][],
  takeTrims: TakeTrim[],
): { words: Word[]; blockDurationSec: number } => concatenateTakesWith(rawTakes, takeTrims, toTrimmedWords);

/**
 * Same concatenation, for anchor matching: keeps words trim.ts cut from
 * playback (see toClampedWords) so a phrase spoken in a padding/dead-air
 * region — which whisper frequently mistimes right up against a real
 * silence boundary — is still findable. Only what's SHOWN should depend on
 * the trim; what the pipeline can SEARCH FOR should not.
 */
export const concatenateTakesForMatching = (
  rawTakes: Word[][],
  takeTrims: TakeTrim[],
): { words: Word[]; blockDurationSec: number } => concatenateTakesWith(rawTakes, takeTrims, toClampedWords);

/** Resolve an anchored position ("blockEnd − 0.9s") to seconds from block start. */
export const anchoredTimeSec = (
  at: AnchoredTime,
  blockDurationSec: number,
): number => {
  const base = at.anchor === "blockStart" ? 0 : blockDurationSec;
  return clamp(base + at.offsetSec, 0, blockDurationSec);
};

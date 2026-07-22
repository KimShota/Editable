import { AnchoredTime, TakeTrim, Word } from "./types";

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** Shift raw-clip words into trimmed-clip time and clamp to the block. */
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

/**
 * Concatenates a block's takes (each in its OWN raw-clip time) into one
 * word list in TRIMMED BLOCK time, exactly as if they'd always been a
 * single clip — this is what lets resolveRoles/assemble treat a multi-take
 * block identically to a single-take one downstream: they only ever see
 * `words` + `blockDurationSec`, never how many files it came from.
 */
export const concatenateTakes = (
  rawTakes: Word[][],
  takeTrims: TakeTrim[],
): { words: Word[]; blockDurationSec: number } => {
  let cursor = 0;
  const words: Word[] = [];
  for (let i = 0; i < takeTrims.length; i++) {
    const { srcInSec, srcOutSec } = takeTrims[i];
    const durationSec = srcOutSec - srcInSec;
    const shifted = toTrimmedWords(rawTakes[i] ?? [], srcInSec, durationSec).map((w) => ({
      text: w.text,
      startSec: w.startSec + cursor,
      endSec: w.endSec + cursor,
    }));
    words.push(...shifted);
    cursor += durationSec;
  }
  return { words, blockDurationSec: cursor };
};

/** Resolve an anchored position ("blockEnd − 0.9s") to seconds from block start. */
export const anchoredTimeSec = (
  at: AnchoredTime,
  blockDurationSec: number,
): number => {
  const base = at.anchor === "blockStart" ? 0 : blockDurationSec;
  return clamp(base + at.offsetSec, 0, blockDurationSec);
};

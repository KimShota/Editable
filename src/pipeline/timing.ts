import { AnchoredTime, Word } from "./types";

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

/** Resolve an anchored position ("blockEnd − 0.9s") to seconds from block start. */
export const anchoredTimeSec = (
  at: AnchoredTime,
  blockDurationSec: number,
): number => {
  const base = at.anchor === "blockStart" ? 0 : blockDurationSec;
  return clamp(base + at.offsetSec, 0, blockDurationSec);
};

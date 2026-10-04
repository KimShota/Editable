import type { ClipKind } from "./clips";

/**
 * Automatic retries per shot kind: how many paid re-generations a shot gets
 * when a check the pipeline can run itself says the clip came back wrong.
 * Running out never stops the video: the best attempt is kept (or a free
 * fallback is used) and the shot is flagged for a look in the editor.
 *
 *   talking   1   ~$3 each; lips that drift from our voice after alignment
 *   green     2   ~$0.2–0.5 each; the model drew on the green screen
 *   animate   0   no automatic check exists: the editor's Regenerate is the retry
 *   footage   –   free, made from the product's own recording
 *   text      –   free
 *
 * Retries only happen in a run that is already paying to generate. A free
 * rebuild (--redo, or a rerun reusing a provider's output) re-checks and
 * flags, never spends. The editor's Regenerate is a single attempt: its
 * price was confirmed up front.
 */
export const RETRY_CAP: Record<ClipKind, number> = { talking: 1, green: 2, animate: 0, footage: 0, text: 0 };

/** Green-screen stills (Gemini, ~$0.13): first try plus 2 retries. */
export const GREEN_STILL_ATTEMPTS = 3;
/** Below this share of green pixels, a still has no usable screen to key onto. */
export const MIN_GREEN_FRACTION = 0.04;
/** Lips further than this from our voice (rms, after alignment) look dubbed. */
export const MAX_LIP_DRIFT_SEC = 0.12;
/** Native audio: below this share of the line's words in the clip's own speech, the clip does not say the line. */
export const MIN_SPOKEN_SHARE = 0.6;
/** Native audio: faster than this (words a minute) she is rushing, and the clip is retried. */
export const MAX_NATIVE_WPM = 230;
/** A green-screen clip whose clean part has to play slower than this to fill
 *  the shot looks like slow motion: retry it. (0.97× passed review on DbAJ.) */
export const MIN_CLEAN_SPEED = 0.8;

/** What the automatic checks measured on one attempt. */
export type Quality = {
  /** Green-screen clips: the clip is clean (nothing drawn on the screen) up to here. */
  cleanUntilSec?: number;
  /** Talking clips: how far the lips miss our voice after alignment; Infinity when alignment failed. */
  lipSyncDriftSec?: number;
  /** Talking clips with native audio: the share of the line's words the clip actually says (0 when nothing was heard). */
  spokenShare?: number;
  /** Talking clips with native audio: how fast she speaks, in words a minute (absent for a short line). */
  wordsPerMin?: number;
};

/** Why an attempt should be retried, or null when it passes. */
export const clipProblem = (kind: ClipKind, shotSec: number, q: Quality): string | null => {
  if (kind === "green" && q.cleanUntilSec !== undefined && q.cleanUntilSec < shotSec * MIN_CLEAN_SPEED) {
    return `the model drew on the screen from ${q.cleanUntilSec.toFixed(1)}s of a ${shotSec.toFixed(1)}s shot`;
  }
  if (kind === "talking" && q.lipSyncDriftSec !== undefined && !(q.lipSyncDriftSec <= MAX_LIP_DRIFT_SEC)) {
    return Number.isFinite(q.lipSyncDriftSec) ? `lips drift ${q.lipSyncDriftSec.toFixed(2)}s from the voice` : "the line could not be found in the clip's speech";
  }
  if (kind === "talking" && q.spokenShare !== undefined && q.spokenShare < MIN_SPOKEN_SHARE) {
    return q.spokenShare === 0 ? "the clip has no speech" : `the clip says only ${Math.round(q.spokenShare * 100)}% of the line`;
  }
  if (kind === "talking" && q.wordsPerMin !== undefined && q.wordsPerMin > MAX_NATIVE_WPM) {
    return `she speaks too fast (${Math.round(q.wordsPerMin)} words a minute)`;
  }
  return null;
};

/** Slower than this, a clip reads as a freeze frame (edl.ts flags it at the same speed). */
export const MIN_USABLE_SPEED = 0.5;

/** Whether an attempt can go on the timeline at all, even flagged. A green
 *  screen clean for only a sliver of the shot cannot: the product footage
 *  is the better stand-in. A talking clip always can (its lips may be off,
 *  but it is still the character saying the line). */
export const usable = (kind: ClipKind, shotSec: number, q: Quality): boolean =>
  kind !== "green" || q.cleanUntilSec === undefined || q.cleanUntilSec >= shotSec * MIN_USABLE_SPEED;

/** Higher is better: the longest clean part, the tightest lip-sync. */
const score = (kind: ClipKind, q: Quality): number => {
  if (kind === "green") return q.cleanUntilSec ?? Infinity;
  if (kind === "talking") return q.spokenShare !== undefined ? q.spokenShare : -(q.lipSyncDriftSec ?? 0);
  return 0;
};

/** The attempt to keep: one that passes if any does (the latest of those), else the best-scoring one. */
export const pickBest = <T extends Quality & { problem: string | null }>(kind: ClipKind, attempts: T[]): T | undefined => {
  const passing = attempts.filter((a) => a.problem === null);
  if (passing.length) return passing[passing.length - 1];
  return attempts.reduce<T | undefined>((best, a) => (best === undefined || score(kind, a) > score(kind, best) ? a : best), undefined);
};

/** The most a shot can cost if every allowed retry is used: `clipUsd` is one
 *  generation, `stillUsd` one green still (0 when the still already exists). */
export const worstCaseUsd = (kind: ClipKind, clipUsd: number, stillUsd = 0): number =>
  clipUsd * (1 + RETRY_CAP[kind]) + stillUsd * GREEN_STILL_ATTEMPTS;

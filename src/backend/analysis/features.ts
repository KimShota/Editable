import type { StyleFeatures, VideoAnalysis } from "./schemas";
import { longTakeRate, montageRunRate } from "./visual";

/**
 * VideoAnalysis → StyleFeatures: the flat numeric summary the style engine
 * compares and embeds. Pure and deterministic — the same analysis always
 * yields the same features, so a stored analysis can be re-projected after
 * a change here without re-running ffmpeg.
 */

/** Motion (0-255 mean-abs-diff units) that maps to "1.0" in the 0-1 energy
 *  and shake features. PROVISIONAL: chosen so the synthetic fixtures land
 *  mid-range (a small box crossing a locked-off frame reads ~7). They are
 *  meant to be re-fitted on the hand-labeled reel set the plan calls for
 *  (section 9) — changing them changes StyleFeatures, so bump
 *  ANALYZER_VERSION when they do. */
export const ENERGY_FULL_SCALE = 20;
export const SHAKE_FULL_SCALE = 30;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export const computeStyleFeatures = (va: VideoAnalysis): StyleFeatures => {
  const { media, cuts, shots, cutLenSec, punchIns, motion, audio, captions, grade, transcript } = va;
  const minutes = media.durationSec / 60;

  const punchInCount = punchIns.filter((p) => p.direction === "in").length;
  const zooms = punchIns.filter((p) => p.direction === "in").map((p) => p.scale);

  return {
    durationSec: media.durationSec,
    cutsPerMin: cuts.length / minutes,
    cutLenP10: cutLenSec.p10,
    cutLenP50: cutLenSec.p50,
    cutLenP90: cutLenSec.p90,
    hookSec: shots.length ? shots[0].endSec - shots[0].startSec : media.durationSec,
    longTakeRate: longTakeRate(shots),
    montageRunRate: montageRunRate(shots),
    punchInRate: cuts.length ? punchInCount / cuts.length : 0,
    zoomScale: zooms.length ? median(zooms) : null,
    energy: clamp01(motion.subjectMean / ENERGY_FULL_SCALE),
    shake: clamp01(motion.shakeMean / SHAKE_FULL_SCALE),
    captionCoverage: captions.coverage,
    captionWords: captions.medianWords,
    // Onsets are only meaningful when speech is known (audio.ts): with no
    // transcript the list is empty, which is "unknown", not "zero SFX".
    sfxPerMin: audio.present && audio.speechRatio !== null ? audio.sfxOnsetsSec.length / minutes : null,
    musicRatio: audio.musicRatio,
    beatStrength: audio.present ? audio.beat.confidence : null,
    speechRatio: audio.speechRatio,
    wordsPerMin: transcript?.wordsPerMin ?? null,
    loudnessMeanDb: audio.loudnessMeanDb,
    loudnessRangeDb: audio.loudnessRangeDb,
    lumaMean: grade.lumaMean,
    lumaSpread: grade.lumaP95 - grade.lumaP5,
    satMean: grade.satMean,
    warmth: grade.warmth,
  };
};

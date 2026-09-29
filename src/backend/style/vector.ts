import type { StyleFeatures } from "../analysis/schemas";
import { STYLE_DIMS, normalizeDim } from "./dims";
import type { CaptionMode, StyleSpec } from "./schemas";

/**
 * Projections into the shared style space (dims.ts): a measured video's
 * StyleFeatures and an authored StyleSpec each become a StyleVec, and
 * everything comparative is done on StyleVecs.
 *
 * A StyleVec carries a `known` mask beside its values. Some dimensions exist
 * on only one side — a spec has no measurable "shake", a finished video has
 * no "grade adjustment" (grade is a delta applied ON a picture; the video
 * only has absolute look statistics) — and a distance that compared a real
 * number to an invented one would report noise as difference. So distance
 * uses only dimensions BOTH sides know; only the stored pgvector embedding
 * fills unknowns, with the dimension's prior.
 */

export type StyleVec = {
  /** 0-1 per dimension, in STYLE_DIMS order. Meaningless where !known. */
  values: number[];
  known: boolean[];
};

type Raw = Partial<Record<string, number | null | undefined>>;

const project = (raw: Raw): StyleVec => {
  const values: number[] = [];
  const known: boolean[] = [];
  for (const dim of STYLE_DIMS) {
    const v = raw[dim.key];
    const n = v === null || v === undefined ? null : normalizeDim(dim, v);
    values.push(n ?? 0);
    known.push(n !== null);
  }
  return { values, known };
};

/**
 * How much of the video, on average, carries on-screen text for each caption
 * mode — the bridge between a spec's discrete mode and the analyzer's
 * measured coverage. Approximate by nature; see analysis/captions.ts for how
 * the reverse mapping is guessed.
 */
export const CAPTION_MODE_COVERAGE: Record<CaptionMode, number> = { none: 0.02, keyword: 0.35, karaoke: 0.75, full: 0.85 };

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export const vectorFromFeatures = (f: StyleFeatures): StyleVec =>
  project({
    cutsPerMin: f.cutsPerMin,
    cutLenP10: f.cutLenP10,
    cutLenP50: f.cutLenP50,
    cutLenP90: f.cutLenP90,
    hookSec: f.hookSec,
    durationSec: f.durationSec,
    longTakeRate: f.longTakeRate,
    montageRunRate: f.montageRunRate,
    punchInRate: f.punchInRate,
    zoomScale: f.zoomScale,
    energy: f.energy,
    shake: f.shake,
    captionCoverage: f.captionCoverage,
    captionWords: f.captionWords,
    sfxPerMin: f.sfxPerMin,
    // The analyzer measures how much audible non-speech there is; a spec
    // authors a music energy. Same idea, different instrument.
    musicEnergy: f.musicRatio,
    beatStrength: f.beatStrength,
    speechRatio: f.speechRatio,
    loudnessDb: f.loudnessMeanDb,
  });

export const vectorFromSpec = (s: StyleSpec): StyleVec => {
  const kinds = Object.values(s.pacing.cutLenSec.byClipKind);
  return project({
    cutsPerMin: s.pacing.cutsPerMin,
    cutLenP10: mean(kinds.map((k) => k.p10)),
    cutLenP50: mean(kinds.map((k) => k.p50)),
    cutLenP90: mean(kinds.map((k) => k.p90)),
    hookSec: s.pacing.hookSec,
    durationSec: s.pacing.totalSec.p50,
    longTakeRate: s.structure.longTake.rate,
    montageRunRate: s.structure.montage.runRate,
    punchInRate: s.camera.punchInRate,
    zoomScale: s.camera.zoomScale,
    energy: mean(s.pacing.energyCurve),
    captionCoverage: CAPTION_MODE_COVERAGE[s.captions.mode],
    captionWords: s.captions.mode === "none" ? null : s.captions.wordsPerGroup,
    overlayDensity: s.overlays.densityPerMin,
    sfxPerMin: s.audio.sfxPerMin,
    musicEnergy: s.audio.musicEnergy,
    beatStrength: s.audio.beatSync,
    gradeSaturation: s.grade.saturation,
    gradeContrast: s.grade.contrast,
    gradeBrightness: s.grade.brightness,
    gradeWarmth: s.grade.temperatureShift,
  });
};

/** The stored embedding: values, with each unknown dimension filled by its
 *  prior so every row has a full-width vector for pgvector. */
export const embeddingOf = (v: StyleVec): number[] =>
  STYLE_DIMS.map((dim, i) => {
    const n = v.known[i] ? v.values[i] : normalizeDim(dim, dim.prior);
    return Math.round((n ?? 0) * 10000) / 10000;
  });

export const deriveEmbedding = (spec: StyleSpec): number[] => embeddingOf(vectorFromSpec(spec));

/** Returns a copy of `spec` with its `embedding` (re)computed. */
export const withEmbedding = (spec: StyleSpec): StyleSpec => ({ ...spec, embedding: deriveEmbedding(spec) });

export type StyleDistance = {
  /** Mean absolute difference over the compared dimensions, 0 (identical)
   *  to 1 (opposite ends of every range). Null when no dimension is known
   *  on both sides. */
  score: number | null;
  compared: number;
  /** Per-dimension absolute difference, for the on-brand gate's diagnostics
   *  ("your cuts are 0.4 slower than your style"). */
  perDim: Record<string, number>;
};

export const styleDistance = (a: StyleVec, b: StyleVec): StyleDistance => {
  const perDim: Record<string, number> = {};
  let sum = 0;
  let compared = 0;
  STYLE_DIMS.forEach((dim, i) => {
    if (!a.known[i] || !b.known[i]) return;
    const d = Math.abs(a.values[i] - b.values[i]);
    perDim[dim.key] = Math.round(d * 10000) / 10000;
    sum += d;
    compared++;
  });
  return { score: compared ? sum / compared : null, compared, perDim };
};

/** pgvector text form: `[0.1,0.2,…]`. Used with an explicit `::vector` cast. */
export const toVectorLiteral = (values: number[]): string => `[${values.join(",")}]`;

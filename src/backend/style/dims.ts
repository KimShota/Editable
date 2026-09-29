/**
 * The shared "style space": the fixed set of dimensions a video's measured
 * StyleFeatures and a StyleSpec's authored fields are BOTH projected onto
 * (vector.ts). Everything comparative — the embedding stored in pgvector,
 * "similar styles" search, the on-brand distance score — is arithmetic in
 * this space, which is what lets a StyleSpec be compared with a video at all.
 *
 * Adding, removing or reordering a dimension changes every stored embedding,
 * and the pgvector column width (db/migrations 011 and 012 declare
 * `vector(24)`): a test fails until the migration and this list agree, and
 * ANALYZER_VERSION must be bumped so stored style_vec rows are recomputed.
 *
 * Each dimension is normalized to 0-1 over a plausible short-form range
 * (`lo`..`hi`, clamped), linearly or on a log scale where the quantity spans
 * an order of magnitude (durations). `prior` is a typical value, used only
 * to fill a dimension for the stored embedding when it is unknown — distance
 * never uses it (it compares only dimensions both sides actually know).
 */

export type StyleDim = {
  key: string;
  lo: number;
  hi: number;
  scale: "linear" | "log";
  prior: number;
};

export const STYLE_DIMS: readonly StyleDim[] = [
  { key: "cutsPerMin", lo: 0, hi: 60, scale: "linear", prior: 15 },
  { key: "cutLenP10", lo: 0.2, hi: 6, scale: "log", prior: 0.8 },
  { key: "cutLenP50", lo: 0.3, hi: 12, scale: "log", prior: 2.5 },
  { key: "cutLenP90", lo: 0.8, hi: 30, scale: "log", prior: 6 },
  { key: "hookSec", lo: 0.3, hi: 8, scale: "log", prior: 2 },
  { key: "durationSec", lo: 5, hi: 180, scale: "log", prior: 30 },
  { key: "longTakeRate", lo: 0, hi: 0.5, scale: "linear", prior: 0.05 },
  { key: "montageRunRate", lo: 0, hi: 0.6, scale: "linear", prior: 0.15 },
  { key: "punchInRate", lo: 0, hi: 0.6, scale: "linear", prior: 0.1 },
  { key: "zoomScale", lo: 1, hi: 1.6, scale: "linear", prior: 1.2 },
  { key: "energy", lo: 0, hi: 1, scale: "linear", prior: 0.3 },
  { key: "shake", lo: 0, hi: 1, scale: "linear", prior: 0.2 },
  { key: "captionCoverage", lo: 0, hi: 1, scale: "linear", prior: 0.4 },
  { key: "captionWords", lo: 1, hi: 12, scale: "linear", prior: 4 },
  { key: "overlayDensity", lo: 0, hi: 20, scale: "linear", prior: 3 },
  { key: "sfxPerMin", lo: 0, hi: 60, scale: "linear", prior: 10 },
  { key: "musicEnergy", lo: 0, hi: 1, scale: "linear", prior: 0.4 },
  { key: "beatStrength", lo: 0, hi: 1, scale: "linear", prior: 0.3 },
  { key: "speechRatio", lo: 0, hi: 1, scale: "linear", prior: 0.6 },
  { key: "loudnessDb", lo: -45, hi: -8, scale: "linear", prior: -22 },
  { key: "gradeSaturation", lo: 0.5, hi: 1.8, scale: "linear", prior: 1 },
  { key: "gradeContrast", lo: 0.6, hi: 1.6, scale: "linear", prior: 1 },
  { key: "gradeBrightness", lo: -0.3, hi: 0.3, scale: "linear", prior: 0 },
  { key: "gradeWarmth", lo: -1, hi: 1, scale: "linear", prior: 0 },
];

export const STYLE_DIM_COUNT = STYLE_DIMS.length;

/** Value → 0-1 within the dimension's range; null for a non-finite value. */
export const normalizeDim = (dim: StyleDim, value: number): number | null => {
  if (!Number.isFinite(value)) return null;
  const v = dim.scale === "log" ? Math.log(Math.max(value, dim.lo * 0.01)) : value;
  const lo = dim.scale === "log" ? Math.log(dim.lo) : dim.lo;
  const hi = dim.scale === "log" ? Math.log(dim.hi) : dim.hi;
  return Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
};

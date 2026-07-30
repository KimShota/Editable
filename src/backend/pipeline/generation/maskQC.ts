import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SubjectBBoxFrac } from "./subjectFit";

/**
 * Measures how much a mask sequence's own alpha boundary jitters frame to
 * frame — the direct quantification of "does this matting engine have
 * temporal memory" (Apple Vision's per-frame segmentation doesn't; RVM's
 * recurrent decoder does). Reads the alpha values themselves rather than
 * thresholding on pixel colour, so both metrics below are hair-colour
 * independent — they work identically for a user with dark, grey, or white
 * hair, unlike an earlier ad-hoc measurement that found the hair boundary
 * by looking for dark pixels.
 *
 * Two metrics, kept side by side rather than one replacing the other —
 * the Phase 1 proof step (matteProof.ts) found they disagree on real
 * footage, and each catches something real the other misses:
 *
 * - `measureMaskJitter` (boundary POSITION tracking, motion-compensated):
 *   the originally-specified gate. On real footage it measured RVM as
 *   WORSE than Vision (ratio 1.7-2.4 vs Vision's 1.2-1.9, neither passing
 *   the 1.3x/4px target) — the opposite of expectations. Root cause,
 *   confirmed by visual inspection of the masks: RVM's alpha carries real
 *   fine hair-wisp detail Vision's smoothed "helmet" segmentation doesn't;
 *   a wisp present in frame N and absent in frame N+1 swings that column's
 *   detected boundary position by many pixels even though the rest of the
 *   alpha field barely changed. This metric mistakes wisp-level detail for
 *   instability, so it's kept as an INFORMATIONAL measurement only (see
 *   gates.ts's own convention for a metric that isn't trustworthy enough
 *   to block a build — e.g. duplicateFrameGates).
 * - `measureTemporalAlphaVariance` (position-agnostic, per-pixel temporal
 *   std within a fixed band — the same shape as officeCompositeQC.ts's
 *   `measureTemporalGrainCropped`): measured RVM's hair-region noise 20-25%
 *   lower than Vision's in absolute terms, and RVM's hair/torso ratio
 *   (2.1x) meaningfully tighter than Vision's (3.7x) on the same footage.
 *   This is the metric that actually tracks visible "shimmer" (does the
 *   alpha value AT A GIVEN SCREEN LOCATION flicker over time), so it's the
 *   PRIMARY, blocking gate.
 */

const MASK_THRESHOLD = 128;

export type JitterQC = {
  hairJitterPx: number;
  torsoJitterPx: number;
  jitterRatio: number;
  maxResidualP95Px: number;
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length);

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = clampIdx(Math.floor((p / 100) * sorted.length), 0, sorted.length - 1);
  return sorted[idx];
};

const clampIdx = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Reads every f%05d.png mask in `masksDir` as one ffmpeg image2-sequence
 *  decode (one process for the whole clip, not one per frame — the same
 *  batch-over-per-frame tradeoff matte.swift's own invocation makes) and
 *  returns one gray Buffer per frame. Exported so a caller measuring both
 *  metrics below (the matte stage's own QC step) decodes the sequence
 *  once and passes the frames to both, rather than paying for the ffmpeg
 *  decode twice. */
export const readGrayMaskSequence = (masksDir: string, width: number, height: number): Buffer[] => {
  const frameSize = width * height;
  const count = fs.readdirSync(masksDir).filter((f) => f.endsWith(".png")).length;
  if (count === 0) return [];
  const raw = execFileSync(
    "ffmpeg",
    [
      "-v", "error",
      "-i", path.join(masksDir, "f%05d.png"),
      "-f", "rawvideo", "-pix_fmt", "gray",
      "-",
    ],
    { maxBuffer: frameSize * count + 1024 * 1024 },
  );
  const frames: Buffer[] = [];
  for (let off = 0; off + frameSize <= raw.length; off += frameSize) {
    frames.push(raw.subarray(off, off + frameSize));
  }
  return frames;
};

/** Topmost row with mask>threshold in column `x` of one gray frame buffer,
 *  linearly interpolated to sub-pixel precision between the last
 *  below-threshold sample and the first above-threshold one. Without this,
 *  a softly feathered alpha ramp (RVM's normal output — several gray
 *  in-between values across the edge, vs. Vision's near-binary edge) gets
 *  its threshold crossing snapped to whichever whole pixel a tiny
 *  frame-to-frame gradient wobble happens to land on, which reads as
 *  "jitter" that has nothing to do with the model's actual temporal
 *  stability — just quantization noise this fixes for both engines alike.
 *  `height` (not -1) when the column has no person pixels at all, so a
 *  dropout reads as "boundary at the very bottom" rather than silently
 *  producing a huge/negative delta against a neighboring frame. */
const columnTop = (frame: Buffer, width: number, height: number, x: number): number => {
  let prev = 0;
  for (let y = 0; y < height; y++) {
    const v = frame[y * width + x];
    if (v > MASK_THRESHOLD) {
      if (y === 0) return 0;
      const denom = v - prev;
      if (denom <= 0) return y;
      return y - 1 + (MASK_THRESHOLD - prev) / denom;
    }
    prev = v;
  }
  return height;
};

/** Left/right person-pixel extent of row `y`, same sub-pixel interpolation
 *  as columnTop. undefined when the row has no person pixels (skipped from
 *  that frame-pair's torso sample rather than treated as a zero-width
 *  edge). */
const rowEdges = (frame: Buffer, width: number, y: number): { left: number; right: number } | undefined => {
  const rowOffset = y * width;
  let left: number | undefined;
  let prev = 0;
  for (let x = 0; x < width; x++) {
    const v = frame[rowOffset + x];
    if (v > MASK_THRESHOLD) {
      const denom = v - prev;
      left = x === 0 || denom <= 0 ? x : x - 1 + (MASK_THRESHOLD - prev) / denom;
      break;
    }
    prev = v;
  }
  if (left === undefined) return undefined;

  let right = left;
  let prevR = 0;
  for (let x = width - 1; x >= 0; x--) {
    const v = frame[rowOffset + x];
    if (v > MASK_THRESHOLD) {
      const denom = v - prevR;
      right = x === width - 1 || denom <= 0 ? x : x + 1 - (MASK_THRESHOLD - prevR) / denom;
      break;
    }
    prevR = v;
  }
  return { left, right };
};

/**
 * Frame-to-frame boundary jitter for a mask sequence, split into a hair
 * region (the middle 60% of the head bbox's width, boundary = topmost
 * alpha>threshold row per column) and a torso region (rows from the head
 * bottom down 1.5 head-heights, boundary = left/right alpha edge per row).
 *
 * Each frame-pair's deltas are motion-compensated: the median signed shift
 * across all sampled columns/rows for that pair is subtracted before
 * measuring residual jitter, so a genuine head turn (which moves the whole
 * boundary coherently) doesn't read as instability — only disagreement
 * BETWEEN columns/rows within the same frame-pair does, which is what
 * frame-independent segmentation actually produces (each column's hair
 * boundary re-solved independently, so neighbors drift apart) and what a
 * recurrent model doesn't.
 */
export const measureMaskJitterFromFrames = (
  frames: Buffer[],
  width: number,
  height: number,
  headBBox: SubjectBBoxFrac,
): JitterQC => {
  if (frames.length < 2) {
    return { hairJitterPx: 0, torsoJitterPx: 0, jitterRatio: 0, maxResidualP95Px: 0 };
  }

  const headTopRow = Math.round(headBBox.topFrac * height);
  const headBottomRow = Math.round(headBBox.bottomFrac * height);
  const headHeightPx = Math.max(1, headBottomRow - headTopRow);
  const headLeftPx = headBBox.leftFrac * width;
  const headRightPx = headBBox.rightFrac * width;
  const headWidthPx = headRightPx - headLeftPx;

  const hairColStart = clampIdx(Math.round(headLeftPx + 0.2 * headWidthPx), 0, width - 1);
  const hairColEnd = clampIdx(Math.round(headLeftPx + 0.8 * headWidthPx), 0, width - 1);
  const hairCols: number[] = [];
  for (let x = hairColStart; x <= hairColEnd; x++) hairCols.push(x);

  const torsoRowStart = clampIdx(headBottomRow, 0, height - 1);
  const torsoRowEnd = clampIdx(headBottomRow + Math.round(1.5 * headHeightPx), 0, height - 1);
  const torsoRows: number[] = [];
  for (let y = torsoRowStart; y <= torsoRowEnd; y++) torsoRows.push(y);

  const hairFrameMeans: number[] = [];
  const hairFrameP95s: number[] = [];
  const torsoFrameMeans: number[] = [];

  for (let t = 0; t < frames.length - 1; t++) {
    const a = frames[t];
    const b = frames[t + 1];

    if (hairCols.length > 0) {
      const deltas = hairCols.map((x) => columnTop(b, width, height, x) - columnTop(a, width, height, x));
      const shift = median(deltas);
      const residuals = deltas.map((d) => Math.abs(d - shift));
      hairFrameMeans.push(mean(residuals));
      hairFrameP95s.push(percentile(residuals, 95));
    }

    if (torsoRows.length > 0) {
      const deltas: number[] = [];
      for (const y of torsoRows) {
        const eA = rowEdges(a, width, y);
        const eB = rowEdges(b, width, y);
        if (!eA || !eB) continue;
        deltas.push(eB.left - eA.left);
        deltas.push(eB.right - eA.right);
      }
      if (deltas.length > 0) {
        const shift = median(deltas);
        const residuals = deltas.map((d) => Math.abs(d - shift));
        torsoFrameMeans.push(mean(residuals));
      }
    }
  }

  const hairJitterPx = mean(hairFrameMeans);
  const torsoJitterPx = mean(torsoFrameMeans);
  const jitterRatio = hairJitterPx / Math.max(torsoJitterPx, 0.25);
  const maxResidualP95Px = hairFrameP95s.length > 0 ? Math.max(...hairFrameP95s) : 0;

  return { hairJitterPx, torsoJitterPx, jitterRatio, maxResidualP95Px };
};

/** masksDir convenience wrapper — decodes the sequence itself. Prefer
 *  `measureMaskJitterFromFrames` when a caller already has the decoded
 *  frames (e.g. alongside `measureTemporalAlphaVarianceFromFrames`) so the
 *  ffmpeg decode isn't paid for twice. */
export const measureMaskJitter = (
  masksDir: string,
  width: number,
  height: number,
  headBBox: SubjectBBoxFrac,
): JitterQC => measureMaskJitterFromFrames(readGrayMaskSequence(masksDir, width, height), width, height, headBBox);

/** Kept as an INFORMATIONAL measurement only — see this file's own doc
 *  comment for why boundary-position tracking doesn't reliably
 *  discriminate temporal stability on real footage (dominated by
 *  wisp-level presence/absence, not genuine wobble). Not wired into a
 *  blocking gate. */
export const HAIR_JITTER_RATIO_MAX = 1.3;
export const HAIR_JITTER_RESIDUAL_P95_MAX_PX = 4;

export const jitterGatePasses = (qc: JitterQC): boolean =>
  qc.jitterRatio <= HAIR_JITTER_RATIO_MAX && qc.maxResidualP95Px < HAIR_JITTER_RESIDUAL_P95_MAX_PX;

export type TemporalAlphaQC = {
  hairStd: number;
  torsoStd: number;
  ratio: number;
};

/** Mean per-pixel temporal standard deviation of alpha value over the
 *  whole clip, within one fixed rectangular band — a FIXED screen
 *  location's own value fluctuating over time, no edge-position finding
 *  involved at all. Same shape as officeCompositeQC.ts's
 *  `measureTemporalGrainCropped`, applied to alpha instead of luma. */
const bandTemporalStdMean = (
  frames: Buffer[],
  width: number,
  rowStart: number,
  rowEnd: number,
  colStart: number,
  colEnd: number,
): number => {
  const n = frames.length;
  let total = 0;
  let count = 0;
  for (let y = rowStart; y <= rowEnd; y++) {
    const rowOffset = y * width;
    for (let x = colStart; x <= colEnd; x++) {
      let sum = 0;
      let sumSq = 0;
      for (const f of frames) {
        const v = f[rowOffset + x];
        sum += v;
        sumSq += v * v;
      }
      const m = sum / n;
      const variance = Math.max(0, sumSq / n - m * m);
      total += Math.sqrt(variance);
      count++;
    }
  }
  return count === 0 ? 0 : total / count;
};

/**
 * Per-pixel temporal alpha variance, split into a hair band (from just
 * above the head bbox top down through the upper ~60% of head height —
 * where hair boundary/texture actually lives) and a torso band (head
 * bottom down 1.5 head-heights) — the PRIMARY, blocking stability gate
 * (see this file's own doc comment for why the boundary-position metric
 * above isn't). `ratio` self-normalizes per user/clip: a subject who
 * simply gestures more has both bands move together; only the hair band
 * being disproportionately noisier than that same subject's own torso
 * indicates a matting defect specifically.
 */
export const measureTemporalAlphaVarianceFromFrames = (
  frames: Buffer[],
  width: number,
  height: number,
  headBBox: SubjectBBoxFrac,
  subjectBBox: SubjectBBoxFrac,
): TemporalAlphaQC => {
  if (frames.length < 2) return { hairStd: 0, torsoStd: 0, ratio: 0 };

  const headTopRow = Math.round(headBBox.topFrac * height);
  const headBottomRow = Math.round(headBBox.bottomFrac * height);
  const headHeightPx = Math.max(1, headBottomRow - headTopRow);

  const hairRowStart = clampIdx(headTopRow - 15, 0, height - 1);
  const hairRowEnd = clampIdx(headTopRow + Math.round(headHeightPx * 0.6), 0, height - 1);
  const hairColStart = clampIdx(Math.round(headBBox.leftFrac * width), 0, width - 1);
  const hairColEnd = clampIdx(Math.round(headBBox.rightFrac * width), 0, width - 1);
  const hairStd = bandTemporalStdMean(frames, width, hairRowStart, hairRowEnd, hairColStart, hairColEnd);

  const torsoRowStart = clampIdx(headBottomRow, 0, height - 1);
  const torsoRowEnd = clampIdx(headBottomRow + Math.round(1.5 * headHeightPx), 0, height - 1);
  const torsoColStart = clampIdx(Math.round(subjectBBox.leftFrac * width), 0, width - 1);
  const torsoColEnd = clampIdx(Math.round(subjectBBox.rightFrac * width), 0, width - 1);
  const torsoStd = bandTemporalStdMean(frames, width, torsoRowStart, torsoRowEnd, torsoColStart, torsoColEnd);

  return { hairStd, torsoStd, ratio: hairStd / Math.max(torsoStd, 0.5) };
};

export const measureTemporalAlphaVariance = (
  masksDir: string,
  width: number,
  height: number,
  headBBox: SubjectBBoxFrac,
  subjectBBox: SubjectBBoxFrac,
): TemporalAlphaQC =>
  measureTemporalAlphaVarianceFromFrames(readGrayMaskSequence(masksDir, width, height), width, height, headBBox, subjectBBox);

/**
 * Calibrated against ALL FOUR of a real job's office blocks (hook,
 * name-reveal, credential, bold-claim — 1.2-4.4s each), measured with
 * pipeline/matte.ts's own extended QC window (see its doc comment): RVM
 * measured 2.34-3.53x, Vision 3.70-4.33x — a clean, non-overlapping split.
 * 3.6 sits in that gap. Superseded an earlier 3.0 figure calibrated
 * against two synthetic 4-second windows that happened to span block
 * TRANSITIONS (more torso motion than any single real block's own held
 * pose actually has) — that number failed every real block regardless of
 * engine once measured against real per-block footage, which is what
 * caught the synthetic calibration's own flaw. Flagged for further
 * recalibration once more users' footage (varied hair colour/lighting/
 * take length) runs through this stage, same as the face/edge luma ratio
 * target.
 */
export const HAIR_TEMPORAL_RATIO_MAX = 3.6;

export const temporalAlphaGatePasses = (qc: TemporalAlphaQC): boolean => qc.ratio <= HAIR_TEMPORAL_RATIO_MAX;

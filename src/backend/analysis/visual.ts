import { execFileSync } from "node:child_process";
import { buildShots, detectChangeTimes } from "../pipeline/shotDetect";
import type { VideoAnalysis } from "./schemas";

/**
 * Everything the analyzer measures from PICTURE alone: cuts, per-clip
 * length distribution, motion energy, camera shake, and punch-in zooms.
 *
 * One ffmpeg rawvideo pass decodes the whole video at 64x112 gray (the
 * vlog redesign plan's `clipSegment` pass, same shape as gates.ts's
 * frameLumaStats) and everything below is arithmetic over those frames in
 * memory — no per-frame process spawns.
 */

const W = 64;
const H = 112;
const FRAME_BYTES = W * H;
const BLOCK_COLS = 4;
const BLOCK_ROWS = 4;
const BLOCK_W = W / BLOCK_COLS;
const BLOCK_H = H / BLOCK_ROWS;

/** Same threshold authoring/analyze.ts uses for hard cuts. */
const SCENE_THRESHOLD = 0.3;
/** Bounds the decoded buffer: a long video is sampled at a lower frame rate
 *  rather than held in memory at 15 fps. 6000 frames = 43 MB. */
const MAX_FRAMES = 6000;
const MAX_FPS = 15;
const MIN_FPS = 4;

/** A frame-pair spike must clear median + this many MADs of the pair-diff
 *  series (and MIN_SPIKE) to be a candidate jump cut. */
const SPIKE_MADS = 6;
const MIN_SPIKE = 12;
/** A spike this close to a hard cut is the same event, not a second cut. */
const NEAR_CUT_SEC = 0.25;
/** A real cut is ISOLATED: its pair-diff towers over the pairs around it.
 *  Shaky handheld footage spikes on every frame, and must not read as a cut
 *  every frame. The spike must exceed the median of its neighbors by this
 *  factor. */
const ISOLATION_RATIO = 2.5;
const ISOLATION_WINDOW = 4;

/** Candidate magnifications tested across a cut. 1.0 is excluded (it is the
 *  baseline) and so is 1.02-1.03, indistinguishable from resampling noise. */
const ZOOM_SCALES = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 1.45, 1.5, 1.6];
/** A zoom is accepted only if it explains the frame pair much better than no
 *  zoom, and by a margin in absolute gray levels, and lands close in
 *  absolute terms. A hard cut to an unrelated scene fits nothing. */
const ZOOM_IMPROVEMENT = 0.6;
const ZOOM_MIN_GAIN = 4;
const ZOOM_MAX_RESIDUAL = 28;
/** A zoom-out samples outside frame a; require at least this share of the
 *  frame to be in-bounds for the comparison to mean anything. */
const MIN_INBOUNDS = 0.4;

/** How far (in 64x112 pixels) a shake can slide the picture and still be
 *  ruled out as "just a translation". */
const MAX_SHIFT = 6;
/** A zoom is rejected if the best plain translation explains the pair at
 *  least this well relative to the zoom: shake is not a punch-in. */
const TRANSLATION_MARGIN = 1.15;
/** A hard cut is dismissed as shake when the best shift leaves under this
 *  share of the un-shifted difference. */
const SHIFT_EXPLAINS = 0.5;

const LONG_TAKE_SEC = 8;
const RUN_MIN_SHOTS = 4;
const RUN_MAX_SHOT_SEC = 0.8;

export const analysisFps = (durationSec: number): number =>
  Math.max(MIN_FPS, Math.min(MAX_FPS, Math.floor(MAX_FRAMES / durationSec)));

type Frames = { data: Buffer; count: number; fps: number };

const readGrayFrames = (filePath: string, durationSec: number): Frames => {
  const fps = analysisFps(durationSec);
  const expected = Math.ceil(durationSec * fps) + 8;
  const data = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", filePath, "-an", "-vf", `fps=${fps},scale=${W}:${H}:flags=area,format=gray`, "-f", "rawvideo", "-"],
    { maxBuffer: expected * FRAME_BYTES * 2 },
  );
  return { data, count: Math.floor(data.length / FRAME_BYTES), fps };
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const quantile = (sorted: number[], q: number): number => {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

export const summarize = (xs: number[]): { p10: number; p50: number; p90: number; mean: number } => {
  const sorted = [...xs].sort((a, b) => a - b);
  return {
    p10: quantile(sorted, 0.1),
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0,
  };
};

/** Mean absolute difference per 4x4 block between two consecutive frames. */
const blockDiffs = (data: Buffer, a: number, b: number): number[] => {
  const offA = a * FRAME_BYTES;
  const offB = b * FRAME_BYTES;
  const sums = new Array<number>(BLOCK_COLS * BLOCK_ROWS).fill(0);
  for (let y = 0; y < H; y++) {
    const by = Math.floor(y / BLOCK_H) * BLOCK_COLS;
    const row = y * W;
    for (let x = 0; x < W; x++) {
      sums[by + Math.floor(x / BLOCK_W)] += Math.abs(data[offA + row + x] - data[offB + row + x]);
    }
  }
  return sums.map((s) => s / (BLOCK_W * BLOCK_H));
};

/**
 * Splits one frame pair's movement into camera shake vs subject motion,
 * per the vlog redesign plan: if EVERY block moves, the camera moved
 * (shake = the median block); if only a few do, something in the scene did
 * (subject = how far the busiest blocks rise above that median).
 */
const splitMotion = (blocks: number[]): { total: number; shake: number; subject: number } => {
  const sorted = [...blocks].sort((a, b) => a - b);
  const shake = median(blocks);
  const top4 = sorted.slice(-4);
  const subject = Math.max(0, top4.reduce((a, b) => a + b, 0) / top4.length - shake);
  return { total: blocks.reduce((a, b) => a + b, 0) / blocks.length, shake, subject };
};

/** Bilinear sample of frame `a` at fractional (x, y); null when out of frame. */
const sampleGray = (data: Buffer, off: number, x: number, y: number): number | null => {
  if (x < 0 || y < 0 || x > W - 1 || y > H - 1) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(W - 1, x0 + 1);
  const y1 = Math.min(H - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const p = (xx: number, yy: number) => data[off + yy * W + xx];
  return (p(x0, y0) * (1 - fx) + p(x1, y0) * fx) * (1 - fy) + (p(x0, y1) * (1 - fx) + p(x1, y1) * fx) * fy;
};

/** Mean absolute difference between frame `b` and frame `a` magnified by
 *  `scale` about the center, over the pixels that land inside frame `a`. */
const zoomResidual = (data: Buffer, a: number, b: number, scale: number): { sad: number; inBounds: number } => {
  const offA = a * FRAME_BYTES;
  const offB = b * FRAME_BYTES;
  const cx = (W - 1) / 2;
  const cy = (H - 1) / 2;
  let sum = 0;
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = sampleGray(data, offA, cx + (x - cx) / scale, cy + (y - cy) / scale);
      if (v === null) continue;
      sum += Math.abs(data[offB + y * W + x] - v);
      n++;
    }
  }
  return { sad: n ? sum / n : Infinity, inBounds: n / FRAME_BYTES };
};

/** Best mean absolute difference between frame b and frame a slid by up to
 *  MAX_SHIFT pixels in any direction, over the overlapping region. */
const bestTranslationResidual = (data: Buffer, a: number, b: number): number => {
  const offA = a * FRAME_BYTES;
  const offB = b * FRAME_BYTES;
  let best = Infinity;
  for (let dy = -MAX_SHIFT; dy <= MAX_SHIFT; dy++) {
    for (let dx = -MAX_SHIFT; dx <= MAX_SHIFT; dx++) {
      let sum = 0;
      let n = 0;
      for (let y = Math.max(0, dy); y < Math.min(H, H + dy); y++) {
        for (let x = Math.max(0, dx); x < Math.min(W, W + dx); x++) {
          sum += Math.abs(data[offB + y * W + x] - data[offA + (y - dy) * W + (x - dx)]);
          n++;
        }
      }
      if (n > 0) best = Math.min(best, sum / n);
    }
  }
  return best;
};

/** The magnification that best explains frame b as a zoomed view of frame
 *  a, or null when no zoom beats "no zoom" convincingly (or when a plain
 *  shift explains the pair just as well). */
export const fitZoom = (data: Buffer, a: number, b: number): number | null => {
  const baseline = zoomResidual(data, a, b, 1).sad;
  let best: { scale: number; sad: number } | null = null;
  for (const scale of ZOOM_SCALES) {
    const r = zoomResidual(data, a, b, scale);
    if (r.inBounds < MIN_INBOUNDS) continue;
    if (!best || r.sad < best.sad) best = { scale, sad: r.sad };
  }
  if (!best) return null;
  if (best.sad > baseline * ZOOM_IMPROVEMENT) return null;
  if (baseline - best.sad < ZOOM_MIN_GAIN) return null;
  if (best.sad > ZOOM_MAX_RESIDUAL) return null;
  if (bestTranslationResidual(data, a, b) < best.sad * TRANSLATION_MARGIN) return null;
  return best.scale;
};

type Cut = VideoAnalysis["cuts"][number];
type PunchIn = VideoAnalysis["punchIns"][number];

export type VisualMeasurements = Pick<VideoAnalysis, "cuts" | "shots" | "cutLenSec" | "motion" | "punchIns">;

/** Index of the frame PAIR (a, a+1) straddling a cut at `atSec`. The
 *  analysis fps rarely lines up with the source's, so the arithmetic guess
 *  can land one pair early or late; the pair within one step with the
 *  biggest change is the one the cut is actually in. */
const pairIndexAt = (atSec: number, fps: number, totals: number[]): number => {
  const guess = Math.ceil(atSec * fps - 1e-6) - 1;
  let best = Math.max(0, Math.min(totals.length - 1, guess));
  for (const j of [guess - 1, guess + 1]) {
    if (j >= 0 && j < totals.length && totals[j] > totals[best]) best = j;
  }
  return best;
};

/** True when frame b is just frame a slid sideways: what handheld shake does
 *  to a picture, and what ffmpeg's scene score can mistake for a cut on a
 *  detailed image. A real cut to a different scene is not explained by any
 *  shift. */
const isMereShift = (data: Buffer, a: number, b: number): boolean => {
  const baseline = zoomResidual(data, a, b, 1).sad;
  return bestTranslationResidual(data, a, b) < baseline * SHIFT_EXPLAINS;
};

export const measureVisual = (filePath: string, durationSec: number): VisualMeasurements => {
  const { data, count, fps } = readGrayFrames(filePath, durationSec);
  if (count < 2) throw new Error(`visual: decoded ${count} frame(s) from ${filePath} — too short to analyze`);

  // Motion / shake curves, and the total pair-diff series used for spikes.
  const subject: number[] = [];
  const shake: number[] = [];
  const totals: number[] = [];
  for (let i = 0; i + 1 < count; i++) {
    const m = splitMotion(blockDiffs(data, i, i + 1));
    subject.push(Math.round(m.subject * 100) / 100);
    shake.push(Math.round(m.shake * 100) / 100);
    totals.push(m.total);
  }

  // Cuts: hard cuts from scene detection, then jump cuts from spikes.
  const hardTimes = detectChangeTimes(filePath, SCENE_THRESHOLD)
    .filter((t) => t > 0 && t < durationSec)
    .filter((t) => {
      const a = pairIndexAt(t, fps, totals);
      return !isMereShift(data, a, a + 1);
    });
  const cuts: Cut[] = hardTimes.map((atSec) => ({ atSec, kind: "hard" as const }));
  const punchIns: PunchIn[] = [];

  const record = (atSec: number, scale: number) =>
    punchIns.push({ atSec, scale, direction: scale > 1 ? "in" : "out" });

  // A hard cut that is ALSO a magnification (e.g. a punch-in that scene
  // detection happened to catch) is still a punch-in.
  for (const t of hardTimes) {
    const a = pairIndexAt(t, fps, totals);
    const scale = fitZoom(data, a, a + 1);
    if (scale !== null) record(t, scale);
  }

  const med = median(totals);
  const mad = median(totals.map((d) => Math.abs(d - med)));
  const spikeThreshold = Math.max(MIN_SPIKE, med + SPIKE_MADS * mad);
  for (let i = 0; i < totals.length; i++) {
    const isLocalMax = totals[i] >= (totals[i - 1] ?? 0) && totals[i] >= (totals[i + 1] ?? 0);
    if (totals[i] < spikeThreshold || !isLocalMax) continue;
    const neighbors: number[] = [];
    for (let j = Math.max(0, i - ISOLATION_WINDOW); j <= Math.min(totals.length - 1, i + ISOLATION_WINDOW); j++) {
      if (j !== i) neighbors.push(totals[j]);
    }
    if (totals[i] < ISOLATION_RATIO * median(neighbors)) continue;
    const atSec = (i + 1) / fps;
    if (hardTimes.some((t) => Math.abs(t - atSec) < NEAR_CUT_SEC)) continue;
    const scale = fitZoom(data, i, i + 1);
    // A spike that is not a zoom is just fast motion, not a cut we can see.
    if (scale === null) continue;
    cuts.push({ atSec, kind: "jump" });
    record(atSec, scale);
  }
  cuts.sort((x, y) => x.atSec - y.atSec);
  punchIns.sort((x, y) => x.atSec - y.atSec);

  const shots = buildShots(
    cuts.map((c) => c.atSec),
    durationSec,
    Number.MAX_SAFE_INTEGER,
  );
  const cutLenSec = summarize(shots.map((s) => s.endSec - s.startSec));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  return {
    cuts,
    shots,
    cutLenSec,
    motion: { hz: fps, subject, shake, subjectMean: mean(subject), shakeMean: mean(shake) },
    punchIns,
  };
};

/** Share of shots that are long takes. */
export const longTakeRate = (shots: VideoAnalysis["shots"]): number =>
  shots.length ? shots.filter((s) => s.endSec - s.startSec >= LONG_TAKE_SEC).length / shots.length : 0;

/** Share of shots sitting inside a montage run: RUN_MIN_SHOTS or more
 *  consecutive shots that are each under RUN_MAX_SHOT_SEC. */
export const montageRunRate = (shots: VideoAnalysis["shots"]): number => {
  let inRuns = 0;
  let run = 0;
  const flush = () => {
    if (run >= RUN_MIN_SHOTS) inRuns += run;
    run = 0;
  };
  for (const s of shots) {
    if (s.endSec - s.startSec < RUN_MAX_SHOT_SEC) run++;
    else flush();
  }
  flush();
  return shots.length ? inRuns / shots.length : 0;
};

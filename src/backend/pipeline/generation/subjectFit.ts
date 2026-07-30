import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Auto-framing for compositeVideoOnBackdrop: measures where the matted
 * subject actually sits in frame (from matte.swift's own masks — no extra
 * detection pass needed) and solves the uniform scale + pixel offset that
 * puts them where the reference reel puts ITS subject (see
 * schemas.ts's PlatesManifestSchema `reference` doc comment). Replaces the
 * old fixed `overlay=0:0` — a talking-head shot filmed at any distance/
 * framing lands at the reference's own head size/position instead of
 * whatever the user happened to film, and a 4K landscape full-body clip
 * (the end card's own source) no longer just crops its middle third.
 */

export type SubjectBBoxFrac = { topFrac: number; bottomFrac: number; leftFrac: number; rightFrac: number };

const MASK_THRESHOLD = 128;

/** Bounding box of "person" pixels (mask value > threshold) in ONE mask
 *  PNG, as fractions of its own (width, height) — undefined if the mask
 *  has no person pixels at all (a dropped Vision frame). */
const maskBBox = (maskPath: string, width: number, height: number): SubjectBBoxFrac | undefined => {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", maskPath, "-f", "rawvideo", "-pix_fmt", "gray", "-"], {
    maxBuffer: 1024 * 1024 * 20,
  });
  let top = -1;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      if (raw[rowOffset + x] > MASK_THRESHOLD) {
        if (top === -1) top = y;
        bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (top === -1 || right === -1) return undefined;
  return { topFrac: top / height, bottomFrac: bottom / height, leftFrac: left / width, rightFrac: right / width };
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

/** Median person bounding box (as frame fractions) over evenly-sampled
 *  frames of a matted mask sequence — robust to the occasional frame where
 *  Vision's segmentation drops out or catches a stray shadow, which a
 *  single-frame read would take at face value. */
export const measureSubjectBBox = (
  masksDir: string,
  width: number,
  height: number,
  sampleCount = 9,
): SubjectBBoxFrac | undefined => {
  const files = fs
    .readdirSync(masksDir)
    .filter((f) => f.endsWith(".png"))
    .sort();
  if (files.length === 0) return undefined;
  const step = Math.max(1, Math.floor(files.length / sampleCount));
  const sampled = files.filter((_, i) => i % step === 0).slice(0, sampleCount);

  const boxes = sampled
    .map((f) => maskBBox(path.join(masksDir, f), width, height))
    .filter((b): b is SubjectBBoxFrac => b !== undefined);
  if (boxes.length === 0) return undefined;

  return {
    topFrac: median(boxes.map((b) => b.topFrac)),
    bottomFrac: median(boxes.map((b) => b.bottomFrac)),
    leftFrac: median(boxes.map((b) => b.leftFrac)),
    rightFrac: median(boxes.map((b) => b.rightFrac)),
  };
};

/** Per-row (left, right, width) of "person" mask pixels, top to bottom,
 *  for rows that have any — the raw material for finding where a head
 *  ends and shoulders begin (maskHeadBBox below), since a shoulder flare
 *  is a jump in per-row WIDTH that a whole-bbox measurement can't see. */
const maskRowWidths = (
  maskPath: string,
  width: number,
  height: number,
): { row: number; left: number; right: number; w: number }[] => {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", maskPath, "-f", "rawvideo", "-pix_fmt", "gray", "-"], {
    maxBuffer: 1024 * 1024 * 20,
  });
  const rows: { row: number; left: number; right: number; w: number }[] = [];
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    let left = -1;
    let right = -1;
    for (let x = 0; x < width; x++) {
      if (raw[rowOffset + x] > MASK_THRESHOLD) {
        if (left === -1) left = x;
        right = x;
      }
    }
    if (left !== -1) rows.push({ row: y, left, right, w: right - left + 1 });
  }
  return rows;
};

// A head's own width profile widens from the crown down to ear/cheek
// level (its peak), then narrows through the jaw toward a neck/chin
// valley, before the shoulders flare back out. How NARROW that valley
// gets is pose-dependent — measured on two real masks: the reference's
// own hands-clear-of-chin pose narrows to <10% of peak width (a true thin
// neck), but this format's own actual footage keeps the hands raised
// right at chin height, plateauing around 65-70% of peak instead of ever
// reaching a thin neck. A fixed "narrowed to X% of peak" threshold
// (this function's first version) works for the first pose and silently
// finds nothing at all for the second. Tracking the running MINIMUM after
// the peak, and stopping at a SUSTAINED rise off that minimum (not a
// single noisy row), finds the valley either way — however deep it goes —
// because it never needs an absolute ratio to fire, just "the narrowest
// point before it starts getting wider again for real."
const PAST_PEAK_DECLINE_RATIO = 0.85;
const FLARE_RISE_RATIO = 1.25;
const FLARE_CONFIRM_ROWS = 8;
const MAX_PLAUSIBLE_HEAD_HEIGHT_FRAC = 0.28;

/** Head-only bbox from ONE mask — same top as the whole-person bbox (the
 *  first row with any person pixels). The BOTTOM is the neck/chin valley:
 *  walk down tracking the running peak row-width (the head's own widest
 *  point, roughly ear/cheek level); once past that peak, track the
 *  running MINIMUM width and stop at the first row that begins a
 *  SUSTAINED rise (FLARE_CONFIRM_ROWS consecutive rows at least
 *  FLARE_RISE_RATIO above that minimum) — the shoulder flare (or, in this
 *  format's own footage, the hands-at-chin flare, which sits close enough
 *  to the true jaw line to be a fine stand-in). Head-bottom is the row
 *  where that minimum occurred, not the flare-confirmation row itself.
 *  Only valid for a frontal/three-quarter face-on shot (the only shot
 *  type this is used for — the talking-head office composite). Undefined
 *  if the mask doesn't have enough rows, or never finds a confirmed rise
 *  (a degenerate/near-empty/cropped-tight mask, or a mask that runs out
 *  before any flare — e.g. a frame cropped tight to the shoulders). */
const maskHeadBBox = (maskPath: string, width: number, height: number): SubjectBBoxFrac | undefined => {
  const rows = maskRowWidths(maskPath, width, height);
  if (rows.length < 12) return undefined;

  let peakWidth = 0;
  let pastPeak = false;
  let minWidth = Infinity;
  let minRow: number | undefined;
  let riseStreak = 0;
  let flareConfirmedAtRow: number | undefined;

  for (const r of rows) {
    if (!pastPeak) {
      if (r.w > peakWidth) {
        peakWidth = r.w;
      } else if (peakWidth > 0 && r.w < peakWidth * PAST_PEAK_DECLINE_RATIO) {
        pastPeak = true;
      }
      continue;
    }
    if (r.w < minWidth) {
      minWidth = r.w;
      minRow = r.row;
      riseStreak = 0;
    } else if (minWidth < Infinity && r.w > minWidth * FLARE_RISE_RATIO) {
      riseStreak++;
      if (riseStreak >= FLARE_CONFIRM_ROWS) {
        flareConfirmedAtRow = r.row;
        break;
      }
    } else {
      riseStreak = 0;
    }
  }
  if (flareConfirmedAtRow === undefined || minRow === undefined) return undefined;

  const headRows = rows.filter((r) => r.row <= minRow);
  if (headRows.length === 0) return undefined;

  const top = headRows[0].row;
  const bottom = headRows[headRows.length - 1].row;
  const left = Math.min(...headRows.map((r) => r.left));
  const right = Math.max(...headRows.map((r) => r.right));
  return { topFrac: top / height, bottomFrac: bottom / height, leftFrac: left / width, rightFrac: right / width };
};

/** Median head-only bounding box over evenly-sampled frames of a matted
 *  mask sequence — the talking-head composite's own framing target
 *  (headTopFrac/headHeightFrac) is a HEAD measurement, and calibrating it
 *  against measureSubjectBBox's whole-person bbox scales the entire
 *  seated person (waist-up, well over 4x taller than just the head) to
 *  fit a head-sized target — a ~4-5x undersized scale that
 *  computeSubjectTransform's own sanity clamp (0.5-2.5) floors at 0.5,
 *  which is exactly the "half life-size" defect this function fixes. */
export const measureHeadBBox = (
  masksDir: string,
  width: number,
  height: number,
  sampleCount = 9,
): SubjectBBoxFrac | undefined => {
  const files = fs
    .readdirSync(masksDir)
    .filter((f) => f.endsWith(".png"))
    .sort();
  if (files.length === 0) return undefined;
  const step = Math.max(1, Math.floor(files.length / sampleCount));
  const sampled = files.filter((_, i) => i % step === 0).slice(0, sampleCount);

  const boxes = sampled
    .map((f) => maskHeadBBox(path.join(masksDir, f), width, height))
    .filter((b): b is SubjectBBoxFrac => b !== undefined)
    // A leaning-in frame or an expressive gesture can pull the shoulders
    // right up under the chin, leaving no room for the running-minimum
    // width to ever settle before the FLARE_RISE_RATIO/FLARE_CONFIRM_ROWS
    // shoulder-flare check fires — measured on the reference reel itself:
    // one frame read 0.44H against a normal frame's own 0.18H. Treat any
    // reading over MAX_PLAUSIBLE as "this frame's detection failed" (same
    // principle as shotQC.ts's implausible-mask guard) rather than let a
    // single outlier frame drag the median — a real head in this shot's
    // own framing never spans more than about a quarter of the canvas.
    .filter((b) => b.bottomFrac - b.topFrac <= MAX_PLAUSIBLE_HEAD_HEIGHT_FRAC);
  if (boxes.length === 0) return undefined;

  return {
    topFrac: median(boxes.map((b) => b.topFrac)),
    bottomFrac: median(boxes.map((b) => b.bottomFrac)),
    leftFrac: median(boxes.map((b) => b.leftFrac)),
    rightFrac: median(boxes.map((b) => b.rightFrac)),
  };
};

export type SubjectTransform = { scale: number; xOffsetPx: number; yOffsetPx: number };

const IDENTITY_TRANSFORM: SubjectTransform = { scale: 1, xOffsetPx: 0, yOffsetPx: 0 };
const clampNum = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/**
 * Solves the uniform scale + pixel offset that moves a measured subject
 * bbox onto a target framing (head-top/height fraction for a talking-head
 * shot; subject-top/height fraction for a full-body shot). Horizontal
 * centering is preserved — only vertical scale/position is fit to target,
 * since the reference's own subjects are all camera-centered. Falls back
 * to the identity transform (no scale/offset — today's behavior) on a
 * missing or degenerate bbox rather than risk a wild scale from a bad
 * measurement.
 */
export const computeSubjectTransform = (
  bbox: SubjectBBoxFrac | undefined,
  target: { topFrac: number; heightFrac: number },
  width: number,
  height: number,
): SubjectTransform => {
  if (!bbox) return IDENTITY_TRANSFORM;

  const measuredHeightFrac = bbox.bottomFrac - bbox.topFrac;
  if (measuredHeightFrac <= 0.02) return IDENTITY_TRANSFORM;

  const scale = clampNum(target.heightFrac / measuredHeightFrac, 0.5, 2.5);
  const centerXFrac = (bbox.leftFrac + bbox.rightFrac) / 2;

  const yOffsetPx = target.topFrac * height - bbox.topFrac * height * scale;
  const xOffsetPx = 0.5 * width - centerXFrac * width * scale;

  return { scale, xOffsetPx: Math.round(xOffsetPx), yOffsetPx: Math.round(yOffsetPx) };
};

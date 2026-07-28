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

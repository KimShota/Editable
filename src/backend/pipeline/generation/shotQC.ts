import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mattePersonToFile } from "./matte";
import { lumaStatsFromGrayBuffer } from "./luma";

/**
 * Measurement-only QC for a generated (or composited) still — see the
 * Kumar "Generated Shots v3" plan's §7. Every function here READS pixels;
 * none of them composite, matte-for-real, or otherwise produce output
 * pixels — matte.ts's mattePersonToFile is reused purely as a measurement
 * tool (its own mask output is discarded except as an artifact for a
 * human to look at, per the plan's explicit "show me a matte/alpha
 * visualisation, not just the composite").
 */

const MASK_THRESHOLD = 128;
/** Pixels within this many px of the mask's own bbox are excluded from
 *  "backdrop" stats — a cheap proxy for a morphologically dilated mask,
 *  avoiding anti-aliased edge/halo pixels biasing the backdrop reading
 *  without needing a real dilation filter pass. */
const BACKDROP_MARGIN_PX = 6;
/** A mask below/above this fraction of the frame is almost certainly a
 *  Vision segmentation miss on a stylized (near-black or near-white)
 *  frame, not a real measurement — callers should defer to Claude-only
 *  adjudication rather than trust a number computed from it. */
const MIN_PLAUSIBLE_MASK_FRAC = 0.05;
const MAX_PLAUSIBLE_MASK_FRAC = 0.95;
/** A straight run of mask-boundary pixels at least this long is a strong
 *  signal of a rectangular crop edge, not a body contour — a real
 *  shoulder/arm/leg silhouette has no perfectly straight run this long. */
const STRAIGHT_RUN_MIN_PX = 40;

export type GeometryQC = {
  bboxTop: number;
  bboxBottom: number;
  bboxLeft: number;
  bboxRight: number;
  bboxHeightFrac: number;
  subjectMedianLuma: number;
  subjectP95Luma: number;
  backdropP50: number;
  backdropP90: number;
  edgeTouch: { top: boolean; left: boolean; right: boolean };
  straightEdgeRunFrac: number;
  subjectFrameFrac: number;
  /** Absolute path to the raw mask PNG — the "matte/alpha visualisation"
   *  artifact; caller decides where (if anywhere) to copy it. */
  maskPath: string;
};

/** Straight-edge (rectangle-crop) detector: for each row inside the
 *  bbox, the mask's own left/right boundary x — a genuine body contour's
 *  boundary wanders roughly every 1-3 rows (shoulders, waist, limb
 *  curvature); a pasted rectangular crop holds the exact same x for
 *  dozens of consecutive rows in a row. Returns the fraction of boundary
 *  rows that sit inside a run of >= STRAIGHT_RUN_MIN_PX identical (or
 *  near-identical, +/-1px) values — checked on left AND right edges,
 *  worst (higher) of the two reported. */
const straightEdgeRunFraction = (maskGray: Buffer, width: number, height: number, top: number, bottom: number): number => {
  const lefts: number[] = [];
  const rights: number[] = [];
  for (let y = top; y <= bottom; y++) {
    let left = -1;
    let right = -1;
    for (let x = 0; x < width; x++) {
      if (maskGray[y * width + x] > MASK_THRESHOLD) {
        if (left === -1) left = x;
        right = x;
      }
    }
    lefts.push(left);
    rights.push(right);
  }

  const runFraction = (vals: number[]): number => {
    let straightCount = 0;
    let runStart = 0;
    for (let i = 1; i <= vals.length; i++) {
      const sameAsPrev = i < vals.length && vals[i] !== -1 && vals[i - 1] !== -1 && Math.abs(vals[i] - vals[i - 1]) <= 1;
      if (!sameAsPrev) {
        const runLen = i - runStart;
        if (runLen >= STRAIGHT_RUN_MIN_PX) straightCount += runLen;
        runStart = i;
      }
    }
    return vals.length > 0 ? straightCount / vals.length : 0;
  };

  return Math.max(runFraction(lefts), runFraction(rights));
};

const readGray = (imagePath: string): Buffer =>
  execFileSync("ffmpeg", ["-v", "error", "-i", imagePath, "-vf", "format=gray", "-f", "rawvideo", "-"], {
    maxBuffer: 1024 * 1024 * 30,
  });

/** Core geometry/luma measurement — bbox, subject vs. backdrop luma
 *  distributions, edge-touch (the direct rectangle-bug indicator: a real
 *  standing/seated subject's mask never touches the LEFT/RIGHT/TOP frame
 *  edge, only the bottom where feet meet floor), and the straight-edge
 *  run fraction. Returns undefined for an implausible mask — see
 *  MIN/MAX_PLAUSIBLE_MASK_FRAC — so a caller never silently trusts
 *  garbage numbers from a failed segmentation.
 *
 *  `maskOutPath` is REQUIRED, not optional: the raw mask lives inside a
 *  scratch temp dir this function deletes before returning (so a caller
 *  can't accidentally hold a path into an already-cleaned-up directory),
 *  and every real caller wants the mask/alpha visualisation artifact
 *  anyway — it's the direct, provable answer to "is this a rectangle or
 *  a person," not an afterthought. */
export const measureGeometry = (
  imagePath: string,
  width: number,
  height: number,
  maskOutPath: string,
): GeometryQC | undefined => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-shotqc-"));
  try {
    const maskPath = mattePersonToFile(imagePath, workDir);
    fs.copyFileSync(maskPath, maskOutPath);
    const imgGray = readGray(imagePath);
    const maskGray = readGray(maskPath);

    let top = -1;
    let bottom = -1;
    let left = width;
    let right = -1;
    let subjectCount = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (maskGray[y * width + x] > MASK_THRESHOLD) {
          if (top === -1) top = y;
          bottom = y;
          if (x < left) left = x;
          if (x > right) right = x;
          subjectCount++;
        }
      }
    }

    const subjectFrameFrac = subjectCount / (width * height);
    if (top === -1 || subjectFrameFrac < MIN_PLAUSIBLE_MASK_FRAC || subjectFrameFrac > MAX_PLAUSIBLE_MASK_FRAC) {
      return undefined;
    }

    const marginTop = Math.max(0, top - BACKDROP_MARGIN_PX);
    const marginBottom = Math.min(height - 1, bottom + BACKDROP_MARGIN_PX);
    const marginLeft = Math.max(0, left - BACKDROP_MARGIN_PX);
    const marginRight = Math.min(width - 1, right + BACKDROP_MARGIN_PX);

    const subjectVals: number[] = [];
    const backdropVals: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (maskGray[i] > MASK_THRESHOLD) {
          subjectVals.push(imgGray[i]);
        } else if (y < marginTop || y > marginBottom || x < marginLeft || x > marginRight) {
          backdropVals.push(imgGray[i]);
        }
        // else: inside the margin-expanded bbox but not subject — a
        // near-edge halo/anti-alias pixel, excluded from both readings.
      }
    }

    const subjectStats = lumaStatsFromGrayBuffer(subjectVals);
    const backdropStats = lumaStatsFromGrayBuffer(backdropVals);
    const straightEdgeRunFrac = straightEdgeRunFraction(maskGray, width, height, top, bottom);

    return {
      bboxTop: top,
      bboxBottom: bottom,
      bboxLeft: left,
      bboxRight: right,
      bboxHeightFrac: (bottom - top) / height,
      subjectMedianLuma: subjectStats.p50,
      subjectP95Luma: subjectStats.p95,
      backdropP50: backdropStats.p50,
      backdropP90: backdropStats.p90,
      edgeTouch: { top: top === 0, left: left === 0, right: right === width - 1 },
      straightEdgeRunFrac,
      subjectFrameFrac,
      maskPath: maskOutPath,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

export type PlateFidelityQC = {
  backdropLumaDeltaP50: number;
  backdropLumaDeltaP90: number;
  meanChannelDeltaRGB: number;
};

/** Compares the generated frame's own backdrop region (outside the
 *  subject mask, margin-excluded same as measureGeometry) against the
 *  checked-in plate's own pixels at the SAME canvas position — ground
 *  truth this pipeline owns, not a guess. Both images must already be at
 *  (width, height) — cover-fit before calling. */
export const measurePlateFidelity = (
  generatedImagePath: string,
  plateFitPath: string,
  maskPath: string,
  width: number,
  height: number,
): PlateFidelityQC => {
  const maskGray = readGray(maskPath);
  const genRaw = execFileSync("ffmpeg", ["-v", "error", "-i", generatedImagePath, "-vf", "format=rgb24", "-f", "rawvideo", "-"], {
    maxBuffer: 1024 * 1024 * 30,
  });
  const plateRaw = execFileSync("ffmpeg", ["-v", "error", "-i", plateFitPath, "-vf", "format=rgb24", "-f", "rawvideo", "-"], {
    maxBuffer: 1024 * 1024 * 30,
  });

  let top = -1, bottom = -1, left = width, right = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (maskGray[y * width + x] > MASK_THRESHOLD) {
        if (top === -1) top = y;
        bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  const marginTop = top === -1 ? height : Math.max(0, top - BACKDROP_MARGIN_PX);
  const marginBottom = top === -1 ? -1 : Math.min(height - 1, bottom + BACKDROP_MARGIN_PX);
  const marginLeft = top === -1 ? width : Math.max(0, left - BACKDROP_MARGIN_PX);
  const marginRight = top === -1 ? -1 : Math.min(width - 1, right + BACKDROP_MARGIN_PX);

  const genLuma: number[] = [];
  const plateLuma: number[] = [];
  let sumAbsDeltaR = 0, sumAbsDeltaG = 0, sumAbsDeltaB = 0, n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const isBackdrop = y < marginTop || y > marginBottom || x < marginLeft || x > marginRight;
      if (!isBackdrop) continue;
      const gi = (y * width + x) * 3;
      const gr = genRaw[gi], gg = genRaw[gi + 1], gb = genRaw[gi + 2];
      const pr = plateRaw[gi], pg = plateRaw[gi + 1], pb = plateRaw[gi + 2];
      genLuma.push(Math.round(0.299 * gr + 0.587 * gg + 0.114 * gb));
      plateLuma.push(Math.round(0.299 * pr + 0.587 * pg + 0.114 * pb));
      sumAbsDeltaR += Math.abs(gr - pr);
      sumAbsDeltaG += Math.abs(gg - pg);
      sumAbsDeltaB += Math.abs(gb - pb);
      n++;
    }
  }

  const genStats = lumaStatsFromGrayBuffer(genLuma);
  const plateStats = lumaStatsFromGrayBuffer(plateLuma);
  const meanChannelDeltaRGB = n > 0 ? (sumAbsDeltaR + sumAbsDeltaG + sumAbsDeltaB) / (3 * n) : 0;

  return {
    backdropLumaDeltaP50: Math.abs(genStats.p50 - plateStats.p50),
    backdropLumaDeltaP90: Math.abs(genStats.p90 - plateStats.p90),
    meanChannelDeltaRGB,
  };
};

/** Geometric half of the sofa "genuinely seated" check — does the
 *  subject's own bbox bottom fall inside the plate's precomputed seat/
 *  floor band (PlatesManifestSchema's seatBandFrac). The semantic half
 *  (does the sofa visibly occlude the thighs, is there a contact shadow)
 *  is faceCheck.ts's job — a pasted cutout can satisfy this geometric
 *  check alone (it can sit at the right HEIGHT) but never the semantic
 *  one, which is why both are required. */
export const bboxBottomInSeatBand = (
  bboxBottom: number,
  height: number,
  seatBandFrac: { top: number; bottom: number },
): boolean => {
  const frac = bboxBottom / height;
  return frac >= seatBandFrac.top && frac <= seatBandFrac.bottom;
};

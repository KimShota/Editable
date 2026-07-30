import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Measurement + solve functions for the office composite's own "reads as
 * pasted" defects (Kumar office-composite plan v6, §2) — sharpness
 * inversion, missing grain, color-temperature mismatch, and a flat (not
 * directional) key light. Every solve here measures the JOB'S OWN take
 * and backdrop and derives a filter from THAT measurement — no constant
 * tuned to one user's footage, per the plan's own "must be a solve, not
 * fixed parameters" requirement (this format ships to users with
 * wildly different rooms/lighting).
 */

const MASK_THRESHOLD = 128;

/** Runs `filterChain` over one image, single ffmpeg call — used to measure
 *  what a candidate filter (e.g. the relight curve about to be baked into
 *  the whole video) actually does to one representative frame BEFORE
 *  committing to a full video pass, since several of this module's solves
 *  need to measure the OUTPUT of a filter, not just its input. */
export const applyFilterToImage = (inputPath: string, filterChain: string, outputPath: string): void => {
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", inputPath, "-vf", filterChain, outputPath]);
};

// ---------------------------------------------------------------------------
// 2a — sharpness (Laplacian variance)
// ---------------------------------------------------------------------------

const grayRaw = (imagePath: string, width: number, height: number): Buffer =>
  execFileSync("ffmpeg", ["-v", "error", "-i", imagePath, "-vf", `scale=${width}:${height}`, "-pix_fmt", "gray", "-f", "rawvideo", "-"], {
    maxBuffer: 1024 * 1024 * 20,
  });

/** 3x3 Laplacian-kernel response variance — a standard sharpness proxy: a
 *  crisp image has strong high-frequency edges (large Laplacian response
 *  variance); a soft/blurred image's edges are weak (small variance).
 *  `mask`, when given (same dimensions, white=include), restricts the
 *  measurement to a region — e.g. only the matted subject's own pixels,
 *  not whatever happens to be behind them. */
export const laplacianVariance = (gray: Buffer, mask: Buffer | undefined, width: number, height: number): number => {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      if (mask && mask[i] < MASK_THRESHOLD) continue;
      const lap = -4 * gray[i] + gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
};

/** Median subject-region Laplacian variance over a few sampled frame/mask
 *  pairs — same sampling shape as subjectFit.ts's own bbox measurement,
 *  for the same reason (a single frame can catch a dropped Vision mask or
 *  an atypically blurry motion-blur frame). */
export const measureSubjectSharpness = (framesDir: string, masksDir: string, width: number, height: number, sampleCount = 5): number | undefined => {
  const files = fs.readdirSync(framesDir).filter((f) => f.endsWith(".png")).sort();
  if (files.length === 0) return undefined;
  const step = Math.max(1, Math.floor(files.length / sampleCount));
  const sampled = files.filter((_, i) => i % step === 0).slice(0, sampleCount);
  const values: number[] = [];
  for (const f of sampled) {
    const maskPath = path.join(masksDir, f);
    if (!fs.existsSync(maskPath)) continue;
    const gray = grayRaw(path.join(framesDir, f), width, height);
    const mask = grayRaw(maskPath, width, height);
    values.push(laplacianVariance(gray, mask, width, height));
  }
  if (values.length === 0) return undefined;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
};

/** Binary-searches a `gblur` sigma (clamped to `maxSigma`) on `plateImagePath`
 *  so its own Laplacian variance lands at `subjectVariance * targetRatioMid`
 *  — i.e. the backdrop reads as softer than the subject by the reference's
 *  own measured ratio, not sharper (the "pasted-on" tell this whole check
 *  exists to catch). A handful of cheap single-frame ffmpeg calls, not a
 *  per-video-frame cost. Degradation: if the plate is ALREADY softer than
 *  target even unblurred (sigma=0), returns 0 rather than trying to
 *  sharpen it — this only ever adds softness, never removes it. */
export const solvePlateBlurSigma = (
  plateImagePath: string,
  width: number,
  height: number,
  subjectVariance: number,
  targetRatioMid: number,
  maxSigma = 2.0,
): number => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-sharpness-solve-"));
  try {
    const targetVariance = subjectVariance * targetRatioMid;
    const varianceAtSigma = (sigma: number): number => {
      const outPath = path.join(workDir, `blur-${sigma.toFixed(3)}.png`);
      if (sigma <= 0.001) {
        fs.copyFileSync(plateImagePath, outPath);
      } else {
        execFileSync("ffmpeg", ["-y", "-v", "error", "-i", plateImagePath, "-vf", `scale=${width}:${height},gblur=sigma=${sigma.toFixed(3)}`, outPath]);
      }
      const gray = grayRaw(outPath, width, height);
      return laplacianVariance(gray, undefined, width, height);
    };

    if (varianceAtSigma(0) <= targetVariance) return 0; // already softer than target
    let lo = 0;
    let hi = maxSigma;
    for (let iter = 0; iter < 6; iter++) {
      const mid = (lo + hi) / 2;
      if (varianceAtSigma(mid) > targetVariance) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// 2b — grain (temporal luma noise on a flat patch)
// ---------------------------------------------------------------------------

/** Temporal standard deviation of ONE cropped patch's own per-frame mean
 *  luma across `sampleCount` CONSECUTIVE frames, read in a single ffmpeg
 *  pipe (not one process per frame — a probe clip is only a handful of
 *  frames, and one `-frames:v N` pull is both cheaper and immune to
 *  `-ss`-seek imprecision on a very short encoded file). Real sensor grain
 *  makes a physically-flat surface (a wall, a desk) flicker frame to frame
 *  even though nothing in the scene moved; a synthesized/still backdrop —
 *  looped as-is, with no grain added — has none of that, which is the
 *  defect this measures. `region` is frame fractions, scoped to a
 *  genuinely flat patch so real texture/edges in the rest of the frame
 *  don't dilute the reading. */
export const measureTemporalGrainCropped = (
  videoPath: string,
  fps: number,
  width: number,
  height: number,
  region: { topFrac: number; bottomFrac: number; leftFrac: number; rightFrac: number },
  sampleCount = 8,
  startSec = 0,
): number => {
  const cropW = Math.max(2, Math.round(width * (region.rightFrac - region.leftFrac)));
  const cropH = Math.max(2, Math.round(height * (region.bottomFrac - region.topFrac)));
  const cropX = Math.round(width * region.leftFrac);
  const cropY = Math.round(height * region.topFrac);
  const raw = execFileSync(
    "ffmpeg",
    [
      "-v", "error", "-ss", String(startSec), "-i", videoPath, "-frames:v", String(sampleCount),
      "-vf", `crop=${cropW}:${cropH}:${cropX}:${cropY},format=gray`,
      "-f", "rawvideo", "-",
    ],
    { maxBuffer: 1024 * 1024 * 20 },
  );
  const frameSize = cropW * cropH;
  const nFrames = Math.floor(raw.length / frameSize);
  if (nFrames < 2) return 0;

  // PER-PIXEL temporal std (median across the patch's own pixels), NOT a
  // patch-spatial-mean's temporal std — verified directly against a known
  // noise filter: averaging ~40k iid noisy pixels together each frame
  // crushes the frame-to-frame swing in that average to near-zero by the
  // law of large numbers (measured: strength-25 noise, patch-mean std
  // ~0.06) even though every individual pixel is visibly flickering
  // (measured: per-pixel frame-to-frame diff, mean abs ~5.4) — exactly the
  // "reads as grain to a human eye, reads as flat to a spatial average"
  // gap that makes the per-pixel version the metric that actually matches
  // what "the plate looks frozen" means.
  const pixelStds: number[] = new Array(frameSize);
  for (let p = 0; p < frameSize; p++) {
    let sum = 0;
    for (let f = 0; f < nFrames; f++) sum += raw[f * frameSize + p];
    const mean = sum / nFrames;
    let sq = 0;
    for (let f = 0; f < nFrames; f++) {
      const d = raw[f * frameSize + p] - mean;
      sq += d * d;
    }
    pixelStds[p] = Math.sqrt(sq / nFrames);
  }
  pixelStds.sort((a, b) => a - b);
  return pixelStds[Math.floor(pixelStds.length / 2)];
};

/** Binary-searches a `noise=alls=X:allf=t+u` strength (0-100) so re-
 *  encoding `sourcePath` with it reproduces `targetStd` on its own flat
 *  `region` patch, measured on the ACTUAL re-encoded probe — not a
 *  synthetic stand-in. This matters more than it sounds: measured directly
 *  that a strength solved against a single clean re-encode of a bare still
 *  systematically UNDERSHOOTS once applied inside the real pipeline (a
 *  strength that measured std 3.15 in isolation measured only ~1.7 on the
 *  actual composited, doubly-recompressed output) — H.264's own rate
 *  control spends more bits on a busy, detailed frame (the composited
 *  subject) and starves flat regions (the background) harder than it
 *  would in an isolated single-color probe, on top of the plain loss from
 *  recompressing an already-lossy intermediate a second time. The fix
 *  isn't a bigger fudge factor on the strength — it's calibrating against
 *  what's ACTUALLY going to ship: `sourcePath` should be the same
 *  (already fully composited, already through every earlier encode pass)
 *  video the real pipeline is about to output, at the SAME point in its
 *  own processing chain this filter will actually run at.
 *  `allf=t` (temporal) reseeds the noise every output frame — a plain
 *  single-shot filter on a still, then looped, would bake in one static
 *  noise pattern and read as temporal std 0 (a frozen image with a
 *  grainy TEXTURE, not the grain-over-time this is meant to add). */
export const solveGrainStrengthOnVideo = (
  sourcePath: string,
  atSec: number,
  region: { topFrac: number; bottomFrac: number; leftFrac: number; rightFrac: number },
  width: number,
  height: number,
  fps: number,
  targetStd: number,
  maxStrength = 40,
  sampleCount = 8,
): number => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-grain-solve-"));
  try {
    const durationSec = (sampleCount + 2) / fps;
    const stdAtStrength = (strength: number): number => {
      const probePath = path.join(workDir, `probe-${strength}.mp4`);
      const vf = strength > 0 ? `noise=alls=${strength}:allf=t+u` : "null";
      execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", String(Math.max(0, atSec)), "-i", sourcePath, "-t", String(durationSec), "-vf", vf, "-pix_fmt", "yuv420p", probePath]);
      return measureTemporalGrainCropped(probePath, fps, width, height, region, sampleCount);
    };
    if (stdAtStrength(0) >= targetStd) return 0; // already grainy enough (unlikely, but don't add more)
    let lo = 0;
    let hi = maxStrength;
    for (let iter = 0; iter < 6; iter++) {
      const mid = (lo + hi) / 2;
      if (stdAtStrength(mid) < targetStd) lo = mid;
      else hi = mid;
    }
    return Math.round((lo + hi) / 2);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// 2c — color temperature (R/B ratio)
// ---------------------------------------------------------------------------

/** Mean R/B ratio ("warmth") over `mask`-included pixels of one RGB
 *  frame — a plain per-channel average ratio, not a full color-science
 *  white-balance estimate, since the plan's own acceptance criterion is
 *  stated in exactly this unit ("room R/B ~2.3"). */
export const measureWarmth = (imagePath: string, width: number, height: number, mask?: Buffer): number => {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", imagePath, "-vf", `scale=${width}:${height}`, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], {
    maxBuffer: 1024 * 1024 * 20,
  });
  let rSum = 0;
  let bSum = 0;
  let n = 0;
  for (let i = 0, px = 0; i < raw.length; i += 3, px++) {
    if (mask && mask[px] < MASK_THRESHOLD) continue;
    rSum += raw[i];
    bSum += raw[i + 2];
    n++;
  }
  if (n === 0 || bSum === 0) return 0;
  return rSum / bSum;
};

/** Binary-searches a single `colorbalance` magnitude `m` (applied as
 *  rs=rm=rh=m, bs=bm=bh=-m — shadows/midtones/highlights uniformly) so
 *  `flatPatchPath`'s own measured R/B lands on `targetRB`. A prior
 *  single-pass linear estimate (assume colorbalance's rs/bs are
 *  ~proportional to their effect on R/B, solve algebraically) was tried
 *  and measured directly: it overshot by >2x (measured R/B 1.68 -> target
 *  2.3 -> solved shift actually produced 4.25) — colorbalance's own
 *  effect on a plain R/B ratio isn't linear enough over this range to
 *  trust a one-shot formula, so this measures the ACTUAL output of each
 *  candidate `m` the same way solvePlateBlurSigma/solveGrainStrength do,
 *  cheaply (only the small cropped flat patch is re-encoded per
 *  iteration, not the whole plate). */
export const solveWarmthFilter = (
  flatPatchPath: string,
  cropWidth: number,
  cropHeight: number,
  targetRB: number,
  maxMagnitude = 0.5,
): { rs: number; bs: number } => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-warmth-solve-"));
  try {
    const rbAtMagnitude = (m: number): number => {
      if (Math.abs(m) < 1e-4) return measureWarmth(flatPatchPath, cropWidth, cropHeight);
      const outPath = path.join(workDir, `warmth-${m.toFixed(4)}.png`);
      const filter = `colorbalance=rs=${m.toFixed(4)}:rm=${m.toFixed(4)}:rh=${m.toFixed(4)}:bs=${(-m).toFixed(4)}:bm=${(-m).toFixed(4)}:bh=${(-m).toFixed(4)}`;
      execFileSync("ffmpeg", ["-y", "-v", "error", "-i", flatPatchPath, "-vf", filter, outPath]);
      return measureWarmth(outPath, cropWidth, cropHeight);
    };

    const baseline = rbAtMagnitude(0);
    if (baseline === 0 || Math.abs(baseline - targetRB) < 0.02) return { rs: 0, bs: 0 };

    // rs=m (redder shadows as m rises) and bs=-m (less blue as m rises)
    // both push R/B UP together — monotonically increasing in m across
    // the WHOLE range, positive or negative, so a single unconditional
    // binary search over [-maxMagnitude, maxMagnitude] converges
    // correctly regardless of which side of target the baseline starts
    // on (an earlier version branched on baseline's own sign and had the
    // negative-side comparison backwards — this formulation sidesteps
    // that whole class of bug by not branching on sign at all).
    let lo = -maxMagnitude;
    let hi = maxMagnitude;
    for (let iter = 0; iter < 7; iter++) {
      const mid = (lo + hi) / 2;
      const rb = rbAtMagnitude(mid);
      if (rb < targetRB) lo = mid; else hi = mid;
    }
    const m = (lo + hi) / 2;
    return { rs: m, bs: -m };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// 2d — directional key (feathered gain mask centered on the head box)
// ---------------------------------------------------------------------------

/** Face-region p97 luma — the metric the v6 plan's own acceptance numbers
 *  are stated in: "middle 60% width of the head bbox, rows 35-85% of the
 *  box (excludes hair), intersected with the person mask, p97 luma".
 *  Distinct from relight.ts's measureFaceLuma (a MEAN over the whole head
 *  bbox including hair) — this is deliberately a narrower, hair-excluding
 *  region and a percentile, not a mean, matching the plan's own
 *  re-derivation of what "the previous target was measured wrong" means. */
export const measureFaceP97 = (
  framesDir: string,
  masksDir: string,
  headBboxFrac: { topFrac: number; bottomFrac: number; leftFrac: number; rightFrac: number },
  width: number,
  height: number,
  sampleCount = 5,
): number | undefined => {
  const boxH = headBboxFrac.bottomFrac - headBboxFrac.topFrac;
  const boxW = headBboxFrac.rightFrac - headBboxFrac.leftFrac;
  const region = {
    topFrac: headBboxFrac.topFrac + boxH * 0.35,
    bottomFrac: headBboxFrac.topFrac + boxH * 0.85,
    leftFrac: headBboxFrac.leftFrac + boxW * 0.2,
    rightFrac: headBboxFrac.leftFrac + boxW * 0.8,
  };
  const files = fs.readdirSync(framesDir).filter((f) => f.endsWith(".png")).sort();
  if (files.length === 0) return undefined;
  const step = Math.max(1, Math.floor(files.length / sampleCount));
  const sampled = files.filter((_, i) => i % step === 0).slice(0, sampleCount);
  const values: number[] = [];
  const top = Math.max(0, Math.floor(region.topFrac * height));
  const bottom = Math.min(height - 1, Math.ceil(region.bottomFrac * height));
  const left = Math.max(0, Math.floor(region.leftFrac * width));
  const right = Math.min(width - 1, Math.ceil(region.rightFrac * width));
  for (const f of sampled) {
    const maskPath = path.join(masksDir, f);
    if (!fs.existsSync(maskPath)) continue;
    const gray = grayRaw(path.join(framesDir, f), width, height);
    const mask = grayRaw(maskPath, width, height);
    for (let y = top; y <= bottom; y++) {
      const row = y * width;
      for (let x = left; x <= right; x++) {
        const i = row + x;
        if (mask[i] >= MASK_THRESHOLD) values.push(gray[i]);
      }
    }
  }
  if (values.length < 20) return undefined;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length * 0.97)];
};

/** Builds a feathered elliptical GAIN expression (for `geq`'s own r=/g=/b=
 *  channel expressions) for a given peak `gain`, centered on the head
 *  box's own center — pure pixel math, no measurement. Pixels far from the
 *  head (hands, torso, background) are left close to untouched — a
 *  directional key, not a flat gain (see the v6 plan's own "hands are
 *  brighter than face" diagnosis: a flat lift lifts hands right along with
 *  the face, which is exactly wrong). */
const buildDirectionalKeyExpr = (
  headBboxFrac: { topFrac: number; bottomFrac: number; leftFrac: number; rightFrac: number },
  gain: number,
  width: number,
  height: number,
): string => {
  const cx = ((headBboxFrac.leftFrac + headBboxFrac.rightFrac) / 2) * width;
  const cy = ((headBboxFrac.topFrac + headBboxFrac.bottomFrac) / 2) * height;
  // Radius: half the head box's own height, scaled up so the falloff
  // covers face+neck+collar without reaching all the way to the hands —
  // a directional key lighting a face doesn't stop at a hard edge, but it
  // also doesn't reach the whole body.
  const radiusPx = ((headBboxFrac.bottomFrac - headBboxFrac.topFrac) * height) * 1.4;
  // Gaussian-shaped falloff: gain(X,Y) = 1 + (GAIN-1) * exp(-d^2 / (2*r^2))
  const distSq = `((X-${cx.toFixed(1)})*(X-${cx.toFixed(1)})+(Y-${cy.toFixed(1)})*(Y-${cy.toFixed(1)}))`;
  return `(1+${(gain - 1).toFixed(4)}*exp(-${distSq}/(2*${(radiusPx * radiusPx).toFixed(1)})))`;
};

const applyDirectionalKey = (cutoutPath: string, expr: string, outPath: string): void => {
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-i", cutoutPath,
    "-vf", `format=rgba,geq=r='r(X\\,Y)*${expr}':g='g(X\\,Y)*${expr}':b='b(X\\,Y)*${expr}':a='alpha(X\\,Y)'`,
    outPath,
  ]);
};

/** Binary-searches the directional key's own peak `gain` (1.0-2.5x) so the
 *  face region's OWN measured p97, AFTER the key is applied, lands on
 *  `targetP97` — not a one-shot target/measured ratio: measured directly
 *  (see this function's own git history / the module's doc comment) that
 *  a one-shot ratio systematically UNDERSHOOTS, because p97 is a
 *  percentile over the WHOLE face region while the gain itself falls off
 *  away from the head's exact center — only pixels near the peak get the
 *  full multiplier, so the region's own p97 lands below what a flat
 *  multiply of that same ratio would produce (measured on this job's own
 *  footage: solving gain=116/40=2.9 (clamped 2.5) as a one-shot only
 *  reached p97 97, not 116). Each iteration is one small single-frame
 *  ffmpeg pass on `cutoutPath` (already extracted/relit by the caller),
 *  not a full video re-encode. `cutoutPath` is an RGBA cutout (subject
 *  already alphamerged + relit); `maskPath` its matching mask. */
export const solveDirectionalKey = (
  cutoutPath: string,
  maskPath: string,
  headBboxFrac: { topFrac: number; bottomFrac: number; leftFrac: number; rightFrac: number },
  width: number,
  height: number,
  targetP97: number,
  maxGain = 2.5,
): string | undefined => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-key-solve-"));
  try {
    const probeFrameDir = path.join(workDir, "frames");
    const probeMaskDir = path.join(workDir, "masks");
    fs.mkdirSync(probeFrameDir);
    fs.mkdirSync(probeMaskDir);
    fs.copyFileSync(maskPath, path.join(probeMaskDir, "f.png"));

    const p97AtGain = (gain: number): number | undefined => {
      const expr = buildDirectionalKeyExpr(headBboxFrac, gain, width, height);
      const probePath = path.join(workDir, `probe-${gain.toFixed(3)}.png`);
      applyDirectionalKey(cutoutPath, expr, probePath);
      fs.copyFileSync(probePath, path.join(probeFrameDir, "f.png"));
      return measureFaceP97(probeFrameDir, probeMaskDir, headBboxFrac, width, height, 1);
    };

    const baseline = p97AtGain(1.0);
    if (baseline === undefined) return undefined;
    if (baseline >= targetP97) return undefined; // already at/above target — no key needed

    let lo = 1.0;
    let hi = maxGain;
    for (let iter = 0; iter < 5; iter++) {
      const mid = (lo + hi) / 2;
      const p97 = p97AtGain(mid) ?? baseline;
      if (p97 < targetP97) lo = mid; else hi = mid;
    }
    // Best-effort: even at maxGain the region's own p97 may not fully
    // reach target (the falloff means it never can, by construction) —
    // hi (the highest gain tried) is the closest approach, same
    // "can't fully close the gap, get as close as the clamp allows"
    // acceptance solvePlateBlurSigma/solveGrainStrength already use.
    return buildDirectionalKeyExpr(headBboxFrac, hi, width, height);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

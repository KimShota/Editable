import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { lumaStatsFromGrayBuffer, LumaStats } from "./luma";

/**
 * Calibrates a per-subject ffmpeg filter chain that maps a cutout's own
 * measured luma distribution onto the reference reel's own talking-head
 * distribution (schemas.ts's PlatesManifestSchema `reference.talkingHead`)
 * — the fix for a subject shot in ordinary bright, flat daylight reading
 * as a "pasted-on cutout" against a dark plate instead of looking like
 * they're actually lit by the plate's own single hard key light.
 * Deliberately simple (a 3-point tone curve + a mild desaturate/warm
 * shift, no directional falloff simulation): it closes the overwhelming
 * majority of the visible gap (measured: p50 2->185 before, this maps p50
 * toward the reference's own ~14) for one extra ffmpeg filter stage, no
 * extra input image or blend pass.
 */

const MASK_THRESHOLD = 128;

/** Grayscale luma of only the "person" pixels (mask > threshold) in one
 *  frame — background pixels from the subject's own original room would
 *  otherwise bias the measurement toward whatever they happened to film
 *  in front of. */
const subjectPixelsFromFrame = (framePath: string, maskPath: string): number[] => {
  const gray = execFileSync("ffmpeg", ["-v", "error", "-i", framePath, "-f", "rawvideo", "-pix_fmt", "gray", "-"], {
    maxBuffer: 1024 * 1024 * 20,
  });
  const mask = execFileSync("ffmpeg", ["-v", "error", "-i", maskPath, "-f", "rawvideo", "-pix_fmt", "gray", "-"], {
    maxBuffer: 1024 * 1024 * 20,
  });
  const values: number[] = [];
  const n = Math.min(gray.length, mask.length);
  for (let i = 0; i < n; i++) {
    if (mask[i] > MASK_THRESHOLD) values.push(gray[i]);
  }
  return values;
};

/** Subject-only luma stats, sampled across a handful of a matted video's
 *  extracted frames (framesDir/masksDir — the same pair
 *  compositeVideoOnBackdrop already produces before this is called). */
export const measureSubjectLuma = (framesDir: string, masksDir: string, sampleCount = 5): LumaStats | undefined => {
  const frameFiles = fs
    .readdirSync(framesDir)
    .filter((f) => f.endsWith(".png"))
    .sort();
  if (frameFiles.length === 0) return undefined;
  const step = Math.max(1, Math.floor(frameFiles.length / sampleCount));
  const sampled = frameFiles.filter((_, i) => i % step === 0).slice(0, sampleCount);

  const values: number[] = [];
  for (const f of sampled) {
    const maskPath = path.join(masksDir, f);
    if (!fs.existsSync(maskPath)) continue;
    // Plain loop, not `values.push(...frame)` — a frame's worth of person
    // pixels can run into the hundreds of thousands, and spreading that
    // many arguments into push() blows the call stack (a real crash this
    // hit immediately on a 720x1280 talking-head frame).
    const framePixels = subjectPixelsFromFrame(path.join(framesDir, f), maskPath);
    for (let i = 0; i < framePixels.length; i++) values.push(framePixels[i]);
  }
  if (values.length < 100) return undefined; // too little person coverage to trust
  return lumaStatsFromGrayBuffer(values);
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Builds the ffmpeg filter (applied to the cutout stream only, after
 * alphamerge) that remaps `measured`'s p50/p95 onto `target`'s — a
 * 3-point piecewise curve (0->0, measured-p50->target-p50,
 * measured-p95->target-p95, 1->1) plus a mild desaturate + warm shift
 * (the reference key light reads slightly warm, not neutral). Falls back
 * to just the desaturate/warm shift (no curve) when the measured
 * highlights are too close to the midtone to give the curve solver
 * strictly increasing points (a flatly-lit subject with little dynamic
 * range of its own).
 *
 * The tone curve runs on the LUMA plane only (lutyuv's y= expression),
 * never touching chroma — NOT ffmpeg's `curves=all=`, which applies the
 * identical nonlinear remap independently to R, G, AND B. Two channels
 * with nearly-equal input values (e.g. light grey fabric, R≈G≈B) can sit
 * on opposite sides of a steep segment of that curve and come out with
 * very different outputs — this shipped as a real bug: light grey pants
 * came out vividly, saturated blue because the curve's steepest segment
 * happened to fall right in the pants' own luma range, amplifying a
 * few-percent per-channel difference into a full-blown color cast.
 * Remapping luma alone and leaving chroma untouched can't produce that
 * failure mode — hue is preserved by construction.
 */
export const solveSubjectRelight = (measured: LumaStats, target: { p50: number; p95: number }): string => {
  const midIn = clamp01(measured.p50 / 255);
  const hiIn = clamp01(measured.p95 / 255);
  const midOut = clamp01(target.p50 / 255);
  const hiOut = clamp01(target.p95 / 255);

  const WARM_DESAT = "eq=saturation=0.88,colorbalance=rs=0.06:gs=0.0:bs=-0.08:rm=0.04:gm=0.0:bm=-0.05";

  // Needs strictly increasing input points; a subject with almost no
  // highlight/midtone separation (hiIn too close to midIn, or either
  // pinned at the extremes) would violate that — skip the curve rather
  // than hand ffmpeg a degenerate piecewise spec.
  if (hiIn - midIn < 0.03 || midIn <= 0.01 || hiIn >= 0.99) {
    return WARM_DESAT;
  }

  const mid255 = midIn * 255;
  const hi255 = hiIn * 255;
  const midOut255 = midOut * 255;
  const hiOut255 = hiOut * 255;
  const lowSlope = midOut255 / mid255;
  const midSlope = (hiOut255 - midOut255) / (hi255 - mid255);
  const hiSlope = (255 - hiOut255) / (255 - hi255);
  const yExpr =
    `if(lt(val\\,${mid255.toFixed(2)})\\,val*${lowSlope.toFixed(4)}\\,` +
    `if(lt(val\\,${hi255.toFixed(2)})\\,${midOut255.toFixed(2)}+(val-${mid255.toFixed(2)})*${midSlope.toFixed(4)}\\,` +
    `${hiOut255.toFixed(2)}+(val-${hi255.toFixed(2)})*${hiSlope.toFixed(4)}))`;
  // format round-trip: cutout arrives as rgba (from alphamerge) — lutyuv
  // needs a yuv-family pixel format to expose y= separately from chroma,
  // and everything downstream (overlay onto the plate) expects rgba back.
  const curve = `format=yuva444p,lutyuv=y='${yExpr}',format=rgba`;
  return `${curve},${WARM_DESAT}`;
};

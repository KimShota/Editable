import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "../paths";

/**
 * Local, free person-cutout compositing — the alternative to asking a
 * generative model to "recreate" the subject. Built on matte.swift (macOS
 * Vision's VNGeneratePersonSegmentationRequest), so the person in the
 * output is always the user's own real pixels: only the backdrop behind
 * them is ever synthesized. Used by generation/higgsfield.ts for the
 * montage insert (one still) and backgroundReplace.ts for talking-head
 * clips (a whole video's worth of frames).
 */

// repoRoot-relative, not __dirname — __dirname points into the bundled
// server output under Next/Turbopack, not this source file's real
// location (see paths.ts's repoRoot doc comment).
const MATTE_SCRIPT = path.join(repoRoot, "src/backend/pipeline/generation/matte.swift");

/**
 * Runs matte.swift over every *.png in `inputDir`, writing a same-named
 * grayscale alpha mask (white = person, already scaled to match each
 * source image) to `outputDir` — ONE swift process for the whole batch,
 * not one per image, since process startup + Vision model load is a fixed
 * ~0.3-0.4s tax that would otherwise dominate wall time across a video
 * clip's worth of frames.
 */
export const matteFramesBatch = (inputDir: string, outputDir: string): void => {
  try {
    execFileSync("swift", [MATTE_SCRIPT, inputDir, outputDir], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? (err as Error).message;
    throw new Error(`matteFramesBatch: Vision segmentation failed for "${inputDir}":\n${stderr.slice(-2000)}`);
  }
};

/** Runs matte.swift on a single still image — a batch of one, for callers
 *  (like the montage insert) that only ever have one frame to matte. */
export const mattePersonToFile = (imagePath: string, workDir: string): string => {
  const inDir = path.join(workDir, "matte-in");
  const outDir = path.join(workDir, "matte-out");
  fs.mkdirSync(inDir, { recursive: true });
  const name = "subject.png";
  fs.copyFileSync(imagePath, path.join(inDir, name));
  matteFramesBatch(inDir, outDir);
  const maskPath = path.join(outDir, name);
  if (!fs.existsSync(maskPath)) {
    throw new Error(`mattePersonToFile: no mask produced for "${imagePath}"`);
  }
  return maskPath;
};

/** Cover-fits (scale + center-crop, never squishes) an image onto an exact
 *  canvas size — used to bring a subject photo (whatever resolution the
 *  user shot it at) to the same pixel dimensions as a generated backdrop
 *  before compositing, since alphamerge/overlay require matching sizes. */
export const resizeCover = (inputPath: string, width: number, height: number, outPath: string): void => {
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-i", inputPath,
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
    outPath,
  ]);
};

/**
 * The silhouette crush curve, solved against the reference reel's own
 * measured pixel values (authoring/draft-baf87683's LIGHT-BG shots):
 * subject torso/legs ≈ (1,0,2), a lit face ≈ (53,42,45) — not flat black,
 * enough detail to read as a face. Piecewise-linear, applied to all three
 * channels identically (a true silhouette desaturates as it darkens):
 * 0 → 0, 37/255 → 0, 190/255 → 50/255, 255/255 → 70/255. Solving the
 * input/output pair (shirt≈40→~1, skin≈190→~50) as a single linear
 * segment gives slope 0.327, intercept ≈37 — verified via a spike
 * composite that landed within a few RGB points of every reference target
 * (backdrop, torso, and face) and produced clean hair/edge separation
 * even against a bright backdrop, the harder case for matte fringing. */
const SILHOUETTE_CRUSH = "curves=all='0/0 0.145/0 0.745/0.196 1/0.275'";

/** `colorchannelmixer` args that multiply RGB by `1 - darken` while
 *  leaving alpha untouched — a cruder, un-measured darken kept only for
 *  callers that want a plain dim rather than the measured silhouette
 *  crush (see SILHOUETTE_CRUSH). */
const darkenFilter = (darken: number): string => {
  const k = 1 - darken;
  return `colorchannelmixer=rr=${k}:gg=${k}:bb=${k}:aa=1`;
};

/**
 * Turns a grayscale mask (white = person, from matte.swift) into a soft
 * black drop shadow — a same-shaped, half-opacity, blurred silhouette.
 *
 * NOT `geq=lum='0':a='0.5*alpha(X,Y)'` (what this replaced): a mask PNG
 * from matte.swift is a plain single-channel grayscale image with no
 * alpha plane at all, so `alpha(X,Y)` reads nothing and geq's `a=` output
 * has nowhere to write once the filter chain is anchored to a
 * `format=gray` pixel format (no alpha plane to allocate) — the shadow
 * silently came out fully opaque across the ENTIRE frame instead of
 * shaped to the silhouette. Invisible against an already-dark backdrop
 * (last session's talking-head/montage work never surfaced it); glaring
 * the moment a light backdrop was tried, which is how this was caught.
 * `split` into two copies of the same grayscale mask sidesteps the plane
 * ambiguity entirely: one copy becomes solid black (`lut=y=0`) for RGB,
 * the other — scaled to half strength — becomes the alpha via
 * `alphamerge`, which unambiguously takes its second input's own gray
 * value AS alpha, no cross-plane reads involved. */
const SHADOW_FROM_MASK =
  "format=gray,split=2[a][b];[a]lut=y=0[blk];[b]lut=y='val*0.5'[al];[blk][al]alphamerge,gblur=sigma=30";

/**
 * A flat, free (no API call) light warm-gray backdrop with a gentle
 * top-to-bottom gradient — the reference's LIGHT-BG shots measure
 * (202,190,196) at the top, falling off toward the floor. Used for
 * SILHOUETTE-style shots (the montage, the end card): unlike the
 * talking-head office backdrop, there's no specific set dressing to
 * generate here, just a seamless-paper-style field, so this skips
 * Higgsfield entirely — cheaper, deterministic, and precisely on-target.
 */
export const generateGradientBackdrop = (width: number, height: number, outPath: string): void => {
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=0xCABEC4:s=${width}x${height}`,
    "-vf", "geq=r='202-37*(Y/H)':g='190-37*(Y/H)':b='196-37*(Y/H)'",
    "-frames:v", "1",
    outPath,
  ]);
};

/**
 * The end card's own backdrop shape — measured from the reference's own
 * end card (shot 15, sampled away from the subject and title text):
 * darker top/bottom edges (~120,108,112) with a brighter plateau in the
 * middle (~162-178). Modeled as a symmetric quadratic vignette peaking at
 * the vertical center; the reference's own plateau is slightly
 * lower-biased (brightest around y=0.75, not exactly centered), which
 * this doesn't reproduce exactly — a reasonable approximation, not a
 * pixel-matched one.
 *
 * Peak boosted past the measured plateau (K=85, not 58 — theoretical peak
 * luma ~197 rather than ~170): the reference's own end-card subject
 * covers only ~28% of frame width, so most of the frame samples the
 * bright plateau. This template's end card composites the subject at
 * full-canvas fill instead (a scope trim — precise subject-scale/position
 * matching wasn't built this pass), which means less backdrop is visible
 * per frame; the extra headroom keeps the visible plateau above the
 * gate's p90>170 threshold despite that dilution.
 */
export const generateVignetteBackdrop = (width: number, height: number, outPath: string): void => {
  const expr = (base: number) => `${base}+85*(1-pow(2*(Y/H-0.5)\\,2))`;
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=0x786C70:s=${width}x${height}`,
    "-vf", `geq=r='${expr(120)}':g='${expr(108)}':b='${expr(112)}'`,
    "-frames:v", "1",
    outPath,
  ]);
};

/**
 * Composites a person, cut out of `subjectImagePath`, onto `backdropPath`
 * (any generated or plain backdrop, same pixel size as the subject) with a
 * soft drop shadow — the shared "put the real subject on a synthesized
 * set" primitive. `silhouette: true` applies the measured crush curve
 * (SILHOUETTE_CRUSH) for shots that call for it (the montage, the end
 * card); `darken` (0..1) is a cruder, un-measured alternative for
 * anything that just wants a plain dim.
 */
export const compositeOnBackdrop = (opts: {
  subjectImagePath: string;
  backdropPath: string;
  outPath: string;
  silhouette?: boolean;
  darken?: number;
}): void => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-matte-"));
  try {
    const mask = mattePersonToFile(opts.subjectImagePath, workDir);

    const cutout = path.join(workDir, "cutout.png");
    execFileSync("ffmpeg", [
      "-y", "-v", "error",
      "-i", opts.subjectImagePath,
      "-i", mask,
      "-filter_complex", "[0][1]alphamerge",
      cutout,
    ]);

    const shadow = path.join(workDir, "shadow.png");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", mask, "-filter_complex", SHADOW_FROM_MASK, "-frames:v", "1", shadow]);

    const crushFilter = opts.silhouette ? SILHOUETTE_CRUSH : opts.darken ? darkenFilter(opts.darken) : undefined;
    const subjectLayer = crushFilter
      ? (() => {
          const darkened = path.join(workDir, "cutout-dark.png");
          execFileSync("ffmpeg", ["-y", "-v", "error", "-i", cutout, "-vf", crushFilter, darkened]);
          return darkened;
        })()
      : cutout;

    execFileSync("ffmpeg", [
      "-y", "-v", "error",
      "-i", opts.backdropPath,
      "-i", shadow,
      "-i", subjectLayer,
      "-filter_complex", "[0][1]overlay=36:56[bg_shadow];[bg_shadow][2]overlay=0:0[out]",
      "-map", "[out]",
      "-frames:v", "1",
      opts.outPath,
    ]);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

/**
 * Video analog of compositeOnBackdrop — mattes and composites EVERY frame
 * of `subjectVideoPath` onto a single static `backdropPath`, preserving
 * the subject's original audio untouched. Only two subprocess calls scale
 * with frame count (extraction, batch matting); the compositing itself is
 * one ffmpeg filtergraph over the whole frame/mask image-sequence pair —
 * ffmpeg applies filters per-frame natively, so there's no need for (and
 * no per-frame cost from) invoking it once per frame.
 */
export const compositeVideoOnBackdrop = (opts: {
  subjectVideoPath: string;
  backdropPath: string;
  outPath: string;
  width: number;
  height: number;
  fps: number;
  silhouette?: boolean;
  darken?: number;
}): void => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-matte-video-"));
  try {
    const framesDir = path.join(workDir, "frames");
    fs.mkdirSync(framesDir);
    // Scale+crop baked into the SAME extraction pass — every frame lands
    // pre-sized to the backdrop's canvas, so nothing downstream needs to
    // resize per-frame.
    execFileSync("ffmpeg", [
      "-y", "-v", "error",
      "-i", opts.subjectVideoPath,
      "-vf", `fps=${opts.fps},scale=${opts.width}:${opts.height}:force_original_aspect_ratio=increase,crop=${opts.width}:${opts.height}`,
      path.join(framesDir, "f%05d.png"),
    ]);

    const masksDir = path.join(workDir, "masks");
    matteFramesBatch(framesDir, masksDir);

    const backdropSized = path.join(workDir, "backdrop.png");
    resizeCover(opts.backdropPath, opts.width, opts.height, backdropSized);

    const crushFilter = opts.silhouette ? SILHOUETTE_CRUSH : opts.darken ? darkenFilter(opts.darken) : undefined;
    const cutoutFilter = crushFilter ? `[1][2]alphamerge,${crushFilter}[cutout]` : "[1][2]alphamerge[cutout]";
    const filterComplex = [
      cutoutFilter,
      `[2]${SHADOW_FROM_MASK}[shadow]`,
      "[0][shadow]overlay=36:56[bg_shadow]",
      "[bg_shadow][cutout]overlay=0:0[out]",
    ].join(";");

    execFileSync("ffmpeg", [
      "-y", "-v", "error",
      "-loop", "1", "-i", backdropSized,
      "-framerate", String(opts.fps), "-i", path.join(framesDir, "f%05d.png"),
      "-framerate", String(opts.fps), "-i", path.join(masksDir, "f%05d.png"),
      "-i", opts.subjectVideoPath,
      "-filter_complex", filterComplex,
      "-map", "[out]",
      "-map", "3:a?",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      opts.outPath,
    ]);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

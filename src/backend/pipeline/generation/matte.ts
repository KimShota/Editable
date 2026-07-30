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

/** Contain-fits (scale to fit within, never crops) an image onto an exact
 *  canvas size, padding the leftover space with a flat color — the fix for
 *  composite-v2's own "rectangles, not people" bug: cover-fitting a
 *  1179x2556 identity photo onto a 720x1280 canvas crops ~18% of the
 *  photo's own height, chopping the body at the photo's frame edge: Vision
 *  segmentation then matches the mask TO that crop line, and the result is
 *  a straight-line mask edge (a rectangle, not a body silhouette). Contain-
 *  fitting instead guarantees the full body is present in the frame handed
 *  to matte.swift, so the mask boundary it finds is the body's own
 *  silhouette, never a photo-frame edge. */
export const resizeContainPad = (inputPath: string, width: number, height: number, outPath: string, padColor = "black"): void => {
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-i", inputPath,
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${padColor}`,
    outPath,
  ]);
};

/** Same cover-fit as resizeCover, but forces an alpha plane through the
 *  filter chain explicitly — used for RGBA overlay assets (e.g. the
 *  desk-foreground mask) where a bare scale/crop's alpha handling
 *  shouldn't be left to chance. */
export const resizeCoverRGBA = (inputPath: string, width: number, height: number, outPath: string): void => {
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-i", inputPath,
    "-vf", `format=rgba,scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
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
 * Darkens a flattened composite laterally toward its own left/right
 * edges — the fix for a composite whose room stays as bright at the frame
 * edges as the reference's own room falls off toward black (measured gap
 * on this job's own footage: reference edge patches ~7-27, this
 * composite's own edges ~40-80 before this runs, despite the wall/plate
 * itself matching almost exactly — the plate isn't the problem, nothing
 * was pulling its own edges down the way a real single-key-light room
 * would). A pure multiplicative RGB scale — 1.0 (no change) at the frame's
 * horizontal center, falling to `minFactor` at the left/right edges along
 * a `power`-shaped curve (PlatesManifestSchema's talkingHead.edgeFalloff)
 * — so a roughly-centered subject (the talking-head composite's own
 * auto-framed subject) is left close to untouched while the room around
 * them pulls down toward the reference's own falloff. Runs on the
 * FLATTENED composite (after the desk foreground is already baked in),
 * not as part of compositeVideoOnBackdrop itself, since it's specific to
 * the talking-head office composite — the broll plate composites (their
 * own subject isn't necessarily centered the same way, e.g. the sofa
 * shot) don't call this.
 */
export const applyLateralFalloff = (
  inputPath: string,
  outputPath: string,
  opts: { minFactor: number; power: number },
): void => {
  const factorExpr = `(1-(1-${opts.minFactor})*pow(abs(X/W-0.5)*2\\,${opts.power}))`;
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-i", inputPath,
    "-vf", `geq=r='r(X\\,Y)*${factorExpr}':g='g(X\\,Y)*${factorExpr}':b='b(X\\,Y)*${factorExpr}'`,
    "-c:a", "copy",
    outputPath,
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
  /** RGBA image composited LAST, on top of the subject — same
   *  desk-foreground idea as compositeVideoOnBackdrop, sized separately
   *  since a still's own backdrop may not be the format's canvas size. */
  foregroundPath?: string;
  subjectFilter?: string;
  subjectTransform?: SubjectTransform;
  /** false skips SHADOW_FROM_MASK's fixed (36,56)px-offset drop shadow —
   *  on a contain-fit subject (see resizeContainPad) that offset shadow is
   *  just a second, blurred copy of the SAME straight-line photo-frame
   *  artifact the contain-fit itself exists to eliminate, so composite-v2's
   *  plate stills turn it off entirely. Default true (unchanged) for any
   *  other caller (e.g. generation/higgsfield.ts's legacy montage insert). */
  shadow?: boolean;
  /** Invoked with mattePersonToFile's own matte-in/matte-out directories
   *  (each containing exactly one same-named file) once the subject is
   *  matted — subjectFit.ts/relight.ts's measurement functions work
   *  unmodified against a single-file directory, so this is the same
   *  `calibrate` shape compositeVideoOnBackdrop uses, just handed a
   *  one-frame "sequence". */
  calibrate?: (matteInDir: string, matteOutDir: string) => { subjectFilter?: string; subjectTransform?: SubjectTransform };
}): void => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-matte-"));
  try {
    const mask = mattePersonToFile(opts.subjectImagePath, workDir);
    const calibrated = opts.calibrate?.(path.join(workDir, "matte-in"), path.join(workDir, "matte-out"));
    const subjectFilter = calibrated?.subjectFilter ?? opts.subjectFilter;
    const transform = calibrated?.subjectTransform ?? opts.subjectTransform ?? IDENTITY_TRANSFORM;
    const scale = transform.scale;
    const scaleFilter = scale !== 1 ? `scale=iw*${scale}:ih*${scale}` : undefined;

    const cutout = path.join(workDir, "cutout.png");
    const cutoutFilter = ["[0][1]alphamerge", crushSubjectFilter(opts, subjectFilter), scaleFilter]
      .filter(Boolean)
      .join(",");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", opts.subjectImagePath, "-i", mask, "-filter_complex", cutoutFilter, cutout]);

    const wantShadow = opts.shadow !== false;
    let shadow: string | undefined;
    if (wantShadow) {
      shadow = path.join(workDir, "shadow.png");
      const shadowFilter = [SHADOW_FROM_MASK, scaleFilter].filter(Boolean).join(",");
      execFileSync("ffmpeg", ["-y", "-v", "error", "-i", mask, "-filter_complex", shadowFilter, "-frames:v", "1", shadow]);
    }

    let foregroundSized: string | undefined;
    if (opts.foregroundPath) {
      const { width, height } = probeImageSize(opts.backdropPath);
      foregroundSized = path.join(workDir, "foreground.png");
      resizeCoverRGBA(opts.foregroundPath, width, height, foregroundSized);
    }

    const shadowX = Math.round(36 * scale) + transform.xOffsetPx;
    const shadowY = Math.round(56 * scale) + transform.yOffsetPx;

    const inputs = [
      "-i", opts.backdropPath,
      ...(shadow ? ["-i", shadow] : []),
      "-i", cutout,
    ];
    // Input indices shift depending on whether the shadow input is present
    // — cutout is input 1 without a shadow, input 2 with one.
    const cutoutInputIdx = shadow ? 2 : 1;
    const filterParts = shadow
      ? [`[0][1]overlay=${shadowX}:${shadowY}[bg]`]
      : [];
    const bgLabel = shadow ? "[bg]" : "[0]";
    if (foregroundSized) {
      inputs.push("-i", foregroundSized);
      filterParts.push(`${bgLabel}[${cutoutInputIdx}]overlay=${transform.xOffsetPx}:${transform.yOffsetPx}[bg_subject]`);
      filterParts.push(`[bg_subject][${cutoutInputIdx + 1}]overlay=0:0[out]`);
    } else {
      filterParts.push(`${bgLabel}[${cutoutInputIdx}]overlay=${transform.xOffsetPx}:${transform.yOffsetPx}[out]`);
    }

    execFileSync("ffmpeg", [
      "-y", "-v", "error",
      ...inputs,
      "-filter_complex", filterParts.join(";"),
      "-map", "[out]",
      "-frames:v", "1",
      opts.outPath,
    ]);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

const crushSubjectFilter = (
  opts: { silhouette?: boolean; darken?: number },
  subjectFilter: string | undefined,
): string | undefined => {
  const crushFilter = opts.silhouette ? SILHOUETTE_CRUSH : opts.darken ? darkenFilter(opts.darken) : undefined;
  return [crushFilter, subjectFilter].filter(Boolean).join(",") || undefined;
};

const probeImageSize = (imagePath: string): { width: number; height: number } => {
  const out = execFileSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x",
    imagePath,
  ]).toString().trim();
  const [width, height] = out.split("x").map(Number);
  return { width, height };
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
export type SubjectTransform = { scale: number; xOffsetPx: number; yOffsetPx: number };

const IDENTITY_TRANSFORM: SubjectTransform = { scale: 1, xOffsetPx: 0, yOffsetPx: 0 };

export const compositeVideoOnBackdrop = (opts: {
  subjectVideoPath: string;
  backdropPath: string;
  outPath: string;
  width: number;
  height: number;
  fps: number;
  silhouette?: boolean;
  darken?: number;
  /** RGBA image, composited LAST (on top of the subject) after being
   *  cover-fit to (width, height) — e.g. a desk-foreground strip the
   *  subject should appear to sit behind. */
  foregroundPath?: string;
  /** Extra ffmpeg filter applied to the cutout only, right after
   *  alphamerge (e.g. relight.ts's calibrated tone curve). */
  subjectFilter?: string;
  /** Uniform scale + pixel offset applied to both the cutout and its
   *  shadow (e.g. subjectFit.ts's auto-framing). Identity if omitted. */
  subjectTransform?: SubjectTransform;
  /** Invoked once frames/masks are extracted (still temp-dir-scoped) and
   *  before the final composite runs, so a caller can measure the subject
   *  (bbox, luma) and derive subjectFilter/subjectTransform without a
   *  separate extraction pass of its own. Overrides the two options above
   *  when it returns a value for either. `backdropFilter`, when returned,
   *  is an extra ffmpeg `-vf` chain applied to the backdrop AFTER its own
   *  cover-fit resize — the office-composite fixes (plate defocus/color-
   *  temperature, both solved against this job's own measured subject and
   *  the fixed plate, never baked-in constants applied blind) hang off
   *  this hook rather than a separate pass, since `calibrate` already has
   *  the subject frames/masks this solve needs in hand. (Grain is NOT
   *  applied here — a temporal-noise filter needs to run on the backdrop's
   *  own VIDEO stream, after `-loop 1` turns the still into a sequence of
   *  otherwise-identical frames, not on the still once (which bakes in one
   *  static noise pattern and reads as a frozen grainy TEXTURE, not real
   *  grain-over-time) — and, separately, a probe-solved strength measured
   *  against just the plate undershoots once it's inside the real
   *  composited-and-recompressed output. See backgroundReplace.ts's own
   *  post-falloff grain step, solved against the actual final encode via
   *  officeCompositeQC.ts's solveGrainStrengthOnVideo.) */
  calibrate?: (framesDir: string, masksDir: string) => { subjectFilter?: string; subjectTransform?: SubjectTransform; backdropFilter?: string };
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

    const calibrated = opts.calibrate?.(framesDir, masksDir);
    const subjectFilter = calibrated?.subjectFilter ?? opts.subjectFilter;
    const transform = calibrated?.subjectTransform ?? opts.subjectTransform ?? IDENTITY_TRANSFORM;

    const backdropSized = path.join(workDir, "backdrop.png");
    resizeCover(opts.backdropPath, opts.width, opts.height, backdropSized);
    if (calibrated?.backdropFilter) {
      const backdropTreated = path.join(workDir, "backdrop-treated.png");
      execFileSync("ffmpeg", ["-y", "-v", "error", "-i", backdropSized, "-vf", calibrated.backdropFilter, backdropTreated]);
      fs.renameSync(backdropTreated, backdropSized);
    }

    let foregroundSized: string | undefined;
    if (opts.foregroundPath) {
      foregroundSized = path.join(workDir, "foreground.png");
      resizeCoverRGBA(opts.foregroundPath, opts.width, opts.height, foregroundSized);
    }

    // Scaling the cutout+shadow uniformly keeps their existing cover-crop
    // framing intact, just resized — so scaling to fit the reference's own
    // head size doesn't distort or re-crop the subject. Even dimensions:
    // libx264 (and several ffmpeg scale paths) reject odd width/height.
    const scale = transform.scale;
    const scaledW = Math.max(2, Math.round((opts.width * scale) / 2) * 2);
    const scaledH = Math.max(2, Math.round((opts.height * scale) / 2) * 2);
    const scaleFilter = scale !== 1 ? `,scale=${scaledW}:${scaledH}` : "";
    // The shadow's own displacement (36,56 at scale 1 — see SHADOW_FROM_MASK
    // callers) scales with the subject so it stays proportionally offset
    // rather than drifting away from a shrunk/grown subject.
    const shadowX = Math.round(36 * scale) + transform.xOffsetPx;
    const shadowY = Math.round(56 * scale) + transform.yOffsetPx;

    const crushFilter = opts.silhouette ? SILHOUETTE_CRUSH : opts.darken ? darkenFilter(opts.darken) : undefined;
    const postAlphaFilter = [crushFilter, subjectFilter].filter(Boolean).join(",");
    const cutoutFilter = postAlphaFilter
      ? `[1][2]alphamerge,${postAlphaFilter}${scaleFilter}[cutout]`
      : `[1][2]alphamerge${scaleFilter}[cutout]`;

    const inputArgs = [
      "-framerate", String(opts.fps), "-loop", "1", "-i", backdropSized,
      "-framerate", String(opts.fps), "-i", path.join(framesDir, "f%05d.png"),
      "-framerate", String(opts.fps), "-i", path.join(masksDir, "f%05d.png"),
      "-i", opts.subjectVideoPath,
    ];
    const filterParts = [
      cutoutFilter,
      `[2]${SHADOW_FROM_MASK}${scaleFilter}[shadow]`,
      `[0][shadow]overlay=${shadowX}:${shadowY}[bg_shadow]`,
    ];
    if (foregroundSized) {
      // Input 4, appended after subjectVideoPath (input 3) so "-map 3:a?"
      // below keeps addressing the subject's own audio regardless.
      inputArgs.push("-framerate", String(opts.fps), "-loop", "1", "-i", foregroundSized);
      filterParts.push(`[bg_shadow][cutout]overlay=${transform.xOffsetPx}:${transform.yOffsetPx}[bg_subject]`);
      filterParts.push(`[bg_subject][4]overlay=0:0,fps=${opts.fps}[out]`);
    } else {
      filterParts.push(`[bg_shadow][cutout]overlay=${transform.xOffsetPx}:${transform.yOffsetPx},fps=${opts.fps}[out]`);
    }
    const filterComplex = filterParts.join(";");

    // `-loop 1 -i backdropSized` is input 0 and (via the first `overlay`)
    // the timebase donor for the whole filtergraph. Without an explicit
    // `-framerate` here ffmpeg defaults a looped still to 25fps — silently
    // resampling every 30fps subject frame onto a 25fps grid and back up
    // to 30fps at output, which shows up as duplicate frames (measured:
    // 17% of frames on a 30fps take). `fps=` at the end of the filtergraph
    // and `-r` on the output are belt-and-braces against the same failure
    // mode recurring if the graph is ever reordered.
    execFileSync("ffmpeg", [
      "-y", "-v", "error",
      ...inputArgs,
      "-filter_complex", filterComplex,
      "-map", "[out]",
      "-map", "3:a?",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-r", String(opts.fps),
      "-c:a", "aac",
      "-shortest",
      opts.outPath,
    ]);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

/** A fully transparent RGBA still at (width, height) — NOT
 *  `color=c=black@0.0`: that `@alpha` suffix on the `color` lavfi source
 *  is silently ignored in this environment (verified: the resulting PNG's
 *  own alpha channel reads 255, fully opaque, despite the `@0.0`).
 *  Forcing alpha to 0 via an explicit `geq` expression after converting
 *  to rgba is what actually produces a transparent pixel. */
const transparentCanvas = (width: number, height: number, outPath: string): void => {
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=black:s=${width}x${height}`,
    "-vf", `format=rgba,geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a=0`,
    "-frames:v", "1",
    outPath,
  ]);
};

/**
 * Same subject cutout + desk-foreground layering as
 * compositeVideoOnBackdrop's own last steps, but with NO backdrop and NO
 * drop shadow — just the subject (matted, transformed, and relit exactly
 * the same way, via the same `calibrate` callback shape) and the
 * foreground, composited onto a transparent canvas and encoded with a
 * real alpha channel (ProRes 4444, .mov). This is the "fg" layer the
 * title z-order fix needs: Remotion composites it ON TOP of the karaoke
 * title, so wherever the subject's own pixels are opaque, they occlude
 * the title text exactly like the flattened composite's own subject
 * does, while the title itself sits BEHIND this layer and becomes
 * visible only where the subject is transparent (see EdlVideo.tsx's
 * render order).
 *
 * ProRes 4444, not VP9/webm: VP9 alpha in a webm container stores alpha
 * as a side-channel ffmpeg's own `overlay` filter doesn't apply on
 * decode by default (verified directly — a webm built this way overlays
 * as fully OPAQUE, showing its own base yuv420p plane, not the intended
 * cutout-on-transparency). ProRes 4444 reports genuine yuva444p on its
 * primary stream and composites correctly through the same overlay
 * filter with no special handling. Bigger on disk than VP9 would be, but
 * this is a short per-job intermediate consumed locally, not something
 * streamed or distributed — reliability wins over file size here.
 *
 * No shadow: a drop shadow only makes visual sense cast onto a backdrop,
 * which this layer doesn't have — the flattened composite (with the
 * backdrop AND its own shadow already baked in) is unaffected by this
 * layer's existence and keeps working exactly as it did before.
 */
export const compositeSubjectAlphaVideo = (opts: {
  subjectVideoPath: string;
  foregroundPath?: string;
  outPath: string;
  width: number;
  height: number;
  fps: number;
  silhouette?: boolean;
  darken?: number;
  subjectFilter?: string;
  subjectTransform?: SubjectTransform;
  calibrate?: (framesDir: string, masksDir: string) => { subjectFilter?: string; subjectTransform?: SubjectTransform };
}): void => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-matte-alpha-"));
  try {
    const framesDir = path.join(workDir, "frames");
    fs.mkdirSync(framesDir);
    execFileSync("ffmpeg", [
      "-y", "-v", "error",
      "-i", opts.subjectVideoPath,
      "-vf", `fps=${opts.fps},scale=${opts.width}:${opts.height}:force_original_aspect_ratio=increase,crop=${opts.width}:${opts.height}`,
      path.join(framesDir, "f%05d.png"),
    ]);

    const masksDir = path.join(workDir, "masks");
    matteFramesBatch(framesDir, masksDir);

    const calibrated = opts.calibrate?.(framesDir, masksDir);
    const subjectFilter = calibrated?.subjectFilter ?? opts.subjectFilter;
    const transform = calibrated?.subjectTransform ?? opts.subjectTransform ?? IDENTITY_TRANSFORM;

    let foregroundSized: string | undefined;
    if (opts.foregroundPath) {
      foregroundSized = path.join(workDir, "foreground.png");
      resizeCoverRGBA(opts.foregroundPath, opts.width, opts.height, foregroundSized);
    }

    const transparentPath = path.join(workDir, "transparent.png");
    transparentCanvas(opts.width, opts.height, transparentPath);

    const scale = transform.scale;
    const scaledW = Math.max(2, Math.round((opts.width * scale) / 2) * 2);
    const scaledH = Math.max(2, Math.round((opts.height * scale) / 2) * 2);
    const scaleFilter = scale !== 1 ? `,scale=${scaledW}:${scaledH}` : "";

    const crushFilter = opts.silhouette ? SILHOUETTE_CRUSH : opts.darken ? darkenFilter(opts.darken) : undefined;
    const postAlphaFilter = [crushFilter, subjectFilter].filter(Boolean).join(",");
    const cutoutFilter = postAlphaFilter
      ? `[1][2]alphamerge,${postAlphaFilter}${scaleFilter}[cutout]`
      : `[1][2]alphamerge${scaleFilter}[cutout]`;

    const inputArgs = [
      "-loop", "1", "-i", transparentPath,
      "-framerate", String(opts.fps), "-i", path.join(framesDir, "f%05d.png"),
      "-framerate", String(opts.fps), "-i", path.join(masksDir, "f%05d.png"),
    ];
    const filterParts = [cutoutFilter];
    if (foregroundSized) {
      inputArgs.push("-loop", "1", "-i", foregroundSized);
      filterParts.push(`[0][cutout]overlay=${transform.xOffsetPx}:${transform.yOffsetPx}:format=auto[bg_subject]`);
      filterParts.push(`[bg_subject][3]overlay=0:0:format=auto,fps=${opts.fps}[out]`);
    } else {
      filterParts.push(`[0][cutout]overlay=${transform.xOffsetPx}:${transform.yOffsetPx}:format=auto,fps=${opts.fps}[out]`);
    }

    // Explicit frame count, not `-shortest`: `-shortest` only takes effect
    // when the OUTPUT has multiple mapped streams of different lengths (it
    // stops at whichever ends first) — this output maps a single video
    // stream (`[out]`, no audio), so `-shortest` has nothing to compare
    // against and is a silent no-op. Input 0 (transparentPath) and,
    // when present, the foreground input are both `-loop 1` — infinite on
    // their own — so with no explicit bound the filtergraph (not just the
    // muxer) runs unbounded. This shipped as a real incident: one call
    // filled tens of GB in under two minutes before being caught and
    // killed by hand. `frameCount`, from the frame sequence actually
    // extracted above, is a hard, unambiguous stop the encoder itself
    // enforces — the same technique provider.ts's animateStillToClip
    // already uses for its own single-video-stream output.
    const frameCount = fs.readdirSync(framesDir).filter((f) => f.endsWith(".png")).length;
    execFileSync("ffmpeg", [
      "-y", "-v", "error",
      ...inputArgs,
      "-filter_complex", filterParts.join(";"),
      "-map", "[out]",
      "-frames:v", String(frameCount),
      "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
      "-r", String(opts.fps),
      opts.outPath,
    ]);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

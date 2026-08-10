import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
// A plain static import, unlike rvm.ts's lazy `require`: that module is
// reachable from the Next server graph and must degrade to the Vision
// fallback when ORT is missing, whereas this one only ever loads inside
// rvmStillsCli.ts's child process — which matte.ts spawns solely when
// rvmAvailable() already said the runtime is there.
import * as ort from "onnxruntime-node";
import { RVM_MODEL_FILE, requireRvmModel } from "./rvm";

/**
 * The stills counterpart to rvm.ts's runRvmOnFrames, and the reason the
 * pipeline runs off macOS at all: it reproduces matte.swift's contract
 * exactly — every *.png in `inputDir` gets a same-named grayscale alpha
 * mask (white = person), scaled back to that source image's own dimensions,
 * written to `outputDir` — so matte.ts's matteFramesBatch can swap one
 * engine for the other without a single caller noticing.
 *
 * The one thing this deliberately does NOT inherit from runRvmOnFrames is
 * recurrent state. RVM threads r1..r4 between video frames because they ARE
 * consecutive; a stills directory is the opposite case. intake.ts samples
 * FRAMING_SAMPLE_COUNT frames spread across an entire take at a fractional
 * fps, and shotQC.ts hands over one generated shot at a time — images with
 * no motion continuity whatsoever. Threading state across them would
 * contaminate each mask with the previous image's subject geometry, which
 * is precisely the measurement both callers are trying to make. Every
 * image therefore starts from zeroed state; the only thing shared across a
 * batch is the loaded session (see below).
 */

/** RVM's encoder/decoder skip connections only line up when both input
 *  dimensions are divisible by 4. Frames from intake/shotQC are already at
 *  format dimensions (1080x1920 and friends, all divisible by 4), but
 *  mattePersonToFile's subject photos are whatever resolution the user
 *  shot at, so inference runs on the rounded-up size and the mask is
 *  scaled back to the source's true dimensions on the way out — matching
 *  matte.swift, which does the same rescale off Vision's own fixed-size
 *  mask (see matte.swift's header). */
const DIM_MULTIPLE = 4;

/** Mirrors matte.ts's RVM_DOWNSAMPLE_RATIO — the value its proof step
 *  froze against real footage at format dimensions, which is what every
 *  production caller here feeds us. Kept as a literal rather than imported
 *  because pipeline/matte.ts imports this module's consumer, not the other
 *  way round. */
const DEFAULT_DOWNSAMPLE_RATIO = 0.25;

/** ...but 0.25 is only sane for format-sized input. A small subject photo
 *  downsampled that hard leaves the encoder with almost no pixels to
 *  segment, so the ratio is raised (never past 1.0) to keep the shorter
 *  side at least this many pixels. */
const MIN_DOWNSAMPLED_SHORT_SIDE = 256;

const roundUpTo = (value: number, multiple: number): number => Math.max(multiple, Math.ceil(value / multiple) * multiple);

const probeImageSize = (imagePath: string): { width: number; height: number } => {
  const out = execFileSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x",
    imagePath,
  ]).toString().trim();
  const [width, height] = out.split("x").map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`rvmStills: could not read image dimensions from "${imagePath}" (ffprobe said "${out}")`);
  }
  return { width, height };
};

/** Decodes an image to raw interleaved RGB24 at exactly (width, height).
 *  Same "ffmpeg does all pixel I/O" convention as rvm.ts's frame stream —
 *  execFileSync rather than a stream here because a still is one bounded
 *  buffer, not an unbounded sequence. */
const decodeRgb = (imagePath: string, width: number, height: number): Buffer =>
  execFileSync(
    "ffmpeg",
    [
      "-v", "error",
      "-i", imagePath,
      "-vf", `scale=${width}:${height}:flags=bicubic,format=rgb24`,
      "-frames:v", "1",
      "-f", "rawvideo",
      "-",
    ],
    { maxBuffer: width * height * 3 + 1024 * 1024 },
  );

/** Writes a raw gray buffer of (srcWidth, srcHeight) out as a PNG at
 *  (outWidth, outHeight), rescaling only when the two differ. */
const writeGrayPng = (
  gray: Buffer,
  srcWidth: number,
  srcHeight: number,
  outWidth: number,
  outHeight: number,
  outPath: string,
): void => {
  const needsScale = srcWidth !== outWidth || srcHeight !== outHeight;
  execFileSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${srcWidth}x${srcHeight}`,
      "-i", "-",
      ...(needsScale ? ["-vf", `scale=${outWidth}:${outHeight}:flags=bicubic`] : []),
      "-frames:v", "1",
      outPath,
    ],
    { input: gray },
  );
};

export type RvmStillsOptions = {
  /** Overrides the auto-chosen encoder downsample ratio. Present for the
   *  proof tool; production callers come through matteFramesBatch, which
   *  has no per-image size knowledge to make the call with. */
  downsampleRatio?: number;
};

/**
 * Mattes every *.png in `inputDir` into `outputDir`. The ONNX session is
 * created once and reused across the whole directory — model load is a
 * fixed ~0.3s tax that would otherwise dominate wall time on intake's
 * multi-frame sample, which is the same batching rationale matte.swift's
 * own one-process-per-batch invocation is built on.
 */
export const runRvmOnStills = async (
  inputDir: string,
  outputDir: string,
  opts: RvmStillsOptions = {},
): Promise<{ imageCount: number }> => {
  requireRvmModel();

  const names = fs
    .readdirSync(inputDir)
    .filter((n) => n.toLowerCase().endsWith(".png"))
    .sort();
  if (names.length === 0) {
    throw new Error(`runRvmOnStills: no *.png files in "${inputDir}"`);
  }
  fs.mkdirSync(outputDir, { recursive: true });

  const session = await ort.InferenceSession.create(RVM_MODEL_FILE);

  for (const name of names) {
    const srcPath = path.join(inputDir, name);
    const { width, height } = probeImageSize(srcPath);
    const inferWidth = roundUpTo(width, DIM_MULTIPLE);
    const inferHeight = roundUpTo(height, DIM_MULTIPLE);

    const ratio =
      opts.downsampleRatio ??
      Math.min(1, Math.max(DEFAULT_DOWNSAMPLE_RATIO, MIN_DOWNSAMPLED_SHORT_SIDE / Math.min(inferWidth, inferHeight)));

    const rgb = decodeRgb(srcPath, inferWidth, inferHeight);
    const pixelCount = inferWidth * inferHeight;
    // interleaved RGB uint8 -> planar CHW float32 in [0,1], the model's
    // expected `src` layout (identical to runRvmOnFrames').
    const chw = new Float32Array(3 * pixelCount);
    for (let p = 0; p < pixelCount; p++) {
      chw[p] = rgb[p * 3] / 255;
      chw[pixelCount + p] = rgb[p * 3 + 1] / 255;
      chw[2 * pixelCount + p] = rgb[p * 3 + 2] / 255;
    }

    // Fresh zeroed recurrent state per image — see this file's header for
    // why this is the whole point, not an oversight.
    const outputs = await session.run({
      src: new ort.Tensor("float32", chw, [1, 3, inferHeight, inferWidth]),
      r1i: new ort.Tensor("float32", new Float32Array([0]), [1, 1, 1, 1]),
      r2i: new ort.Tensor("float32", new Float32Array([0]), [1, 1, 1, 1]),
      r3i: new ort.Tensor("float32", new Float32Array([0]), [1, 1, 1, 1]),
      r4i: new ort.Tensor("float32", new Float32Array([0]), [1, 1, 1, 1]),
      downsample_ratio: new ort.Tensor("float32", new Float32Array([ratio]), [1]),
    });

    const pha = outputs.pha.data as Float32Array;
    const grayBuf = Buffer.alloc(pixelCount);
    for (let p = 0; p < pixelCount; p++) {
      grayBuf[p] = Math.max(0, Math.min(255, Math.round(pha[p] * 255)));
    }

    writeGrayPng(grayBuf, inferWidth, inferHeight, width, height, path.join(outputDir, name));
  }

  return { imageCount: names.length };
};

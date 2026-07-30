import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
// Type-only: erased at compile time, so this doesn't turn ORT into a hard
// module-load dependency — the actual module is `require`d lazily inside
// runRvmOnFrames/rvmAvailable so a missing/broken install degrades to the
// Vision fallback instead of crashing on import.
import type { Tensor as OrtTensor } from "onnxruntime-node";
import { modelsDir } from "../paths";

/**
 * Robust Video Matting (RVM, PeterL1n/RobustVideoMatting) — a recurrent,
 * video-native person-matting model, run locally via ONNX Runtime. Unlike
 * matte.swift's frame-independent Vision segmentation, RVM threads a
 * recurrent state (r1..r4) across frames, so consecutive frames' hair/edge
 * boundaries agree with each other instead of each being re-solved from
 * scratch — see generation/maskQC.ts for the jitter measurement that
 * quantifies the difference.
 *
 * GPL-3.0 licensed (code and weights). Fine to depend on here: this
 * pipeline runs server-side only and is never distributed to end users, so
 * GPL's copyleft obligations (which attach to distribution) don't apply.
 */

export const RVM_MODEL_FILE = path.join(modelsDir, "rvm_mobilenetv3_fp32.onnx");

export const requireRvmModel = (): void => {
  if (!fs.existsSync(RVM_MODEL_FILE)) {
    throw new Error(
      `RVM model not found at ${RVM_MODEL_FILE}. Download it with:\n` +
        `  curl -L -o models/rvm_mobilenetv3_fp32.onnx https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx`,
    );
  }
};

/** True when the RVM model file is present AND onnxruntime-node loads —
 *  the single switch that decides matte.ts's engine choice (RVM primary,
 *  Vision + temporal filtering as fallback) so a missing model/runtime
 *  degrades gracefully instead of crashing the pipeline. */
export const rvmAvailable = (): boolean => {
  if (!fs.existsSync(RVM_MODEL_FILE)) return false;
  try {
    require("onnxruntime-node");
    return true;
  } catch {
    return false;
  }
};

/**
 * Streams raw interleaved RGB24 frames of exactly (width, height) out of a
 * video via one ffmpeg process, yielding one frame-sized buffer at a time
 * as soon as it's available — never holds more than one frame in memory,
 * so wall-clock and memory both stay bounded regardless of clip length.
 * RVM's recurrent state must be processed strictly in frame order anyway
 * (each frame's inference depends on the previous frame's r1..r4 output),
 * so a pull-based stream is a natural fit, not just a memory optimization.
 */
async function* readRgbFrameStream(
  videoPath: string,
  width: number,
  height: number,
  fps: number,
): AsyncGenerator<Buffer> {
  const frameSize = width * height * 3;
  const proc = spawn("ffmpeg", [
    "-v", "error",
    "-i", videoPath,
    "-vf", `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=rgb24`,
    "-f", "rawvideo",
    "-",
  ]);

  const chunks: Buffer[] = [];
  let pending = 0;
  let done = false;
  let procErr: Error | undefined;
  const wake: Array<() => void> = [];

  proc.stdout.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    pending += chunk.length;
    wake.splice(0).forEach((fn) => fn());
  });
  proc.on("error", (err) => {
    procErr = err;
    wake.splice(0).forEach((fn) => fn());
  });
  proc.on("close", (code) => {
    done = true;
    if (code !== 0 && !procErr) procErr = new Error(`readRgbFrameStream: ffmpeg exited ${code} for "${videoPath}"`);
    wake.splice(0).forEach((fn) => fn());
  });

  const waitForData = () => new Promise<void>((resolve) => wake.push(resolve));

  while (true) {
    while (pending < frameSize && !done && !procErr) {
      await waitForData();
    }
    if (procErr) throw procErr;
    if (pending < frameSize) break; // trailing partial frame at EOF — discard
    const buf = Buffer.concat(chunks, pending);
    chunks.length = 0;
    chunks.push(buf.subarray(frameSize));
    pending = buf.length - frameSize;
    yield buf.subarray(0, frameSize);
  }
}

export type RvmOptions = {
  width: number;
  height: number;
  fps: number;
  /** Internal resolution RVM runs its encoder at, as a fraction of
   *  (width, height) — the model's own recommended knob for trading
   *  fine-detail recall against speed. 0.375 is the official guidance for
   *  HD-ish (720-1280px-tall) input; the proof step compares this against
   *  0.25 on real footage before either is frozen as the default. */
  downsampleRatio?: number;
};

const DEFAULT_DOWNSAMPLE_RATIO = 0.375;

/**
 * Runs RVM over every frame of `videoPath`, writing a same-index grayscale
 * alpha mask (`f00001.png`, `f00002.png`, ...) to `outMasksDir` — the RVM
 * analog of matte.ts's `matteFramesBatch`, with one crucial difference:
 * the four recurrent state tensors (r1..r4) are threaded from each frame's
 * output back into the next frame's input, in order, which is what gives
 * RVM its temporal consistency. Frames are fed strictly one at a time
 * (never batched) so memory stays bounded regardless of clip length.
 */
export const runRvmOnFrames = async (
  videoPath: string,
  outMasksDir: string,
  opts: RvmOptions,
): Promise<{ frameCount: number }> => {
  requireRvmModel();
  const ort = require("onnxruntime-node") as typeof import("onnxruntime-node");
  const { width, height, fps, downsampleRatio = DEFAULT_DOWNSAMPLE_RATIO } = opts;

  fs.mkdirSync(outMasksDir, { recursive: true });

  const session = await ort.InferenceSession.create(RVM_MODEL_FILE);

  // Recurrent states start as zero tensors of shape [1,1,1,1] — the
  // official RVM ONNX contract broadcasts this to whatever internal shape
  // each recurrent stage actually needs on the first frame.
  let r1i: OrtTensor = new ort.Tensor("float32", new Float32Array([0]), [1, 1, 1, 1]);
  let r2i: OrtTensor = new ort.Tensor("float32", new Float32Array([0]), [1, 1, 1, 1]);
  let r3i: OrtTensor = new ort.Tensor("float32", new Float32Array([0]), [1, 1, 1, 1]);
  let r4i: OrtTensor = new ort.Tensor("float32", new Float32Array([0]), [1, 1, 1, 1]);
  const downsampleTensor = new ort.Tensor("float32", new Float32Array([downsampleRatio]), [1]);

  const pixelCount = width * height;
  const encodeQueue: Promise<void>[] = [];
  let frameCount = 0;

  for await (const rgb of readRgbFrameStream(videoPath, width, height, fps)) {
    // interleaved RGB uint8 -> planar CHW float32 in [0,1] — the model's
    // expected `src` layout.
    const chw = new Float32Array(3 * pixelCount);
    for (let p = 0; p < pixelCount; p++) {
      chw[p] = rgb[p * 3] / 255;
      chw[pixelCount + p] = rgb[p * 3 + 1] / 255;
      chw[2 * pixelCount + p] = rgb[p * 3 + 2] / 255;
    }
    const src = new ort.Tensor("float32", chw, [1, 3, height, width]);

    const outputs = await session.run({
      src,
      r1i,
      r2i,
      r3i,
      r4i,
      downsample_ratio: downsampleTensor,
    });

    r1i = outputs.r1o as OrtTensor;
    r2i = outputs.r2o as OrtTensor;
    r3i = outputs.r3o as OrtTensor;
    r4i = outputs.r4o as OrtTensor;

    const pha = outputs.pha.data as Float32Array;
    const gray = Buffer.alloc(pixelCount);
    for (let p = 0; p < pixelCount; p++) {
      gray[p] = Math.max(0, Math.min(255, Math.round(pha[p] * 255)));
    }

    frameCount++;
    const outPath = path.join(outMasksDir, `f${String(frameCount).padStart(5, "0")}.png`);
    encodeQueue.push(writeGrayPng(gray, width, height, outPath));
  }

  if (frameCount === 0) {
    throw new Error(`runRvmOnFrames: no frames extracted from "${videoPath}"`);
  }

  await Promise.all(encodeQueue);
  return { frameCount };
};

/** Encodes a raw gray byte buffer to a PNG via one ffmpeg process reading
 *  rawvideo from stdin — mirrors the rest of the pipeline's "ffmpeg does
 *  all pixel I/O" convention rather than pulling in a PNG-encoding
 *  library. Spawned (not execFileSync) so many frames can encode
 *  concurrently while the next frame's ORT inference runs. */
const writeGrayPng = (gray: Buffer, width: number, height: number, outPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-y", "-v", "error",
      "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${width}x${height}`,
      "-i", "-",
      "-frames:v", "1",
      outPath,
    ]);
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`writeGrayPng: ffmpeg exited ${code} for ${outPath}`))));
    proc.stdin.end(gray);
  });

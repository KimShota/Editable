import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildCutoutPreview, extractCanvasFrames, matteFramesBatch } from "../generation/matte";
import {
  HAIR_JITTER_RATIO_MAX,
  HAIR_JITTER_RESIDUAL_P95_MAX_PX,
  HAIR_TEMPORAL_RATIO_MAX,
  jitterGatePasses,
  JitterQC,
  measureMaskJitterFromFrames,
  measureTemporalAlphaVarianceFromFrames,
  readGrayMaskSequence,
  temporalAlphaGatePasses,
  TemporalAlphaQC,
} from "../generation/maskQC";
import { runRvmOnFrames } from "../generation/rvm";
import { measureHeadBBox, measureSubjectBBox } from "../generation/subjectFit";

/**
 * Standalone proof step for the RVM matting rework (see the plan's Phase
 * 1) — cuts one real subclip, mattes it with RVM and/or the existing
 * Vision path, and reports the hair/torso jitter metric for each so the
 * new engine's temporal stability can be inspected and measured BEFORE
 * anything in the real pipeline (matte stage, composite, gates) is
 * rewired to depend on it.
 *
 *   npm run matte:proof -- --video <path> [--in <sec>] [--out <sec>]
 *     [--outDir <dir>] [--engine rvm|vision|both] [--downsample <ratio>]
 */

type Engine = "rvm" | "vision" | "both";
const ENGINES: Engine[] = ["rvm", "vision", "both"];

type Args = {
  video: string;
  inSec: number;
  outSec?: number;
  outDir: string;
  engine: Engine;
  downsampleRatio?: number;
  width: number;
  height: number;
  fps: number;
};

const parseArgs = (argv: string[]): Args => {
  const args: Partial<Args> = { inSec: 0, outDir: "artifacts/matte-proof", engine: "both", width: 720, height: 1280, fps: 30 };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--video":
        args.video = argv[++i];
        break;
      case "--in":
        args.inSec = Number(argv[++i]);
        break;
      case "--out":
        args.outSec = Number(argv[++i]);
        break;
      case "--outDir":
        args.outDir = argv[++i];
        break;
      case "--engine": {
        const engine = argv[++i] as Engine;
        if (!ENGINES.includes(engine)) throw new Error(`--engine must be one of: ${ENGINES.join(", ")}`);
        args.engine = engine;
        break;
      }
      case "--downsample":
        args.downsampleRatio = Number(argv[++i]);
        break;
      case "--width":
        args.width = Number(argv[++i]);
        break;
      case "--height":
        args.height = Number(argv[++i]);
        break;
      case "--fps":
        args.fps = Number(argv[++i]);
        break;
      default:
        throw new Error(`unknown argument "${argv[i]}"`);
    }
  }
  if (!args.video) {
    throw new Error(
      "usage: npm run matte:proof -- --video <path> [--in <sec>] [--out <sec>] [--outDir <dir>] [--engine rvm|vision|both] [--downsample <ratio>]",
    );
  }
  return args as Args;
};

const countPngs = (dir: string): number => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".png")).length : 0);

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const { video, inSec, outSec, outDir, engine, downsampleRatio, width, height, fps } = args;

  fs.mkdirSync(outDir, { recursive: true });

  const subclipPath = path.join(outDir, "subclip.mp4");
  const durationArgs = outSec !== undefined ? ["-t", String(outSec - inSec)] : [];
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-ss", String(inSec),
    "-i", video,
    ...durationArgs,
    "-c:v", "libx264", "-c:a", "aac",
    subclipPath,
  ]);
  console.log(`subclip: ${subclipPath} (${inSec}s${outSec !== undefined ? `–${outSec}s` : "–end"})`);

  // Shared frame extraction — same fps/scale/crop chain compositeVideoOnBackdrop
  // uses, so both engines' masks apply to pixel-identical frames.
  const framesDir = path.join(outDir, "frames");
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  extractCanvasFrames(subclipPath, framesDir, { width, height, fps });
  const extractedFrameCount = countPngs(framesDir);
  console.log(`extracted ${extractedFrameCount} frames at ${width}x${height}@${fps}fps`);

  const engines: Exclude<Engine, "both">[] = engine === "both" ? ["rvm", "vision"] : [engine];
  const results: Record<string, { frameCount: number; jitter: JitterQC; temporal: TemporalAlphaQC }> = {};

  for (const eng of engines) {
    const masksDir = path.join(outDir, `masks-${eng}`);
    fs.rmSync(masksDir, { recursive: true, force: true });
    fs.mkdirSync(masksDir, { recursive: true });

    const t0 = Date.now();
    let frameCount: number;
    if (eng === "rvm") {
      const r = await runRvmOnFrames(subclipPath, masksDir, { width, height, fps, downsampleRatio });
      frameCount = r.frameCount;
    } else {
      matteFramesBatch(framesDir, masksDir);
      frameCount = countPngs(masksDir);
    }
    const wallMs = Date.now() - t0;

    if (frameCount !== extractedFrameCount) {
      console.warn(
        `matteProof: ${eng} produced ${frameCount} masks vs ${extractedFrameCount} extracted frames — ` +
          `${eng === "vision" ? "Vision dropped some frames (partial segmentation failure)" : "unexpected mismatch, investigate before wiring this engine into the pipeline"}`,
      );
    }

    const headBBox = measureHeadBBox(masksDir, width, height);
    const subjectBBox = measureSubjectBBox(masksDir, width, height);
    if (!headBBox || !subjectBBox) {
      console.warn(`matteProof: ${eng} — could not measure a bbox from these masks, skipping jitter/temporal metrics`);
      continue;
    }
    const frames = readGrayMaskSequence(masksDir, width, height);
    const jitter = measureMaskJitterFromFrames(frames, width, height, headBBox);
    const temporal = measureTemporalAlphaVarianceFromFrames(frames, width, height, headBBox, subjectBBox);
    results[eng] = { frameCount, jitter, temporal };

    const previewPath = path.join(outDir, `cutout-preview-${eng}.mov`);
    buildCutoutPreview(framesDir, masksDir, Math.min(frameCount, extractedFrameCount), width, height, fps, previewPath);
    console.log(`${eng}: ${frameCount} masks in ${wallMs}ms — preview at ${previewPath}`);
  }

  fs.writeFileSync(path.join(outDir, "jitter.json"), JSON.stringify(results, null, 2));

  console.log("\n[informational] boundary-position jitter — NOT a blocking gate (see maskQC.ts doc comment)");
  console.log("engine      frames  hairJitterPx  torsoJitterPx  jitterRatio  maxP95ResidualPx  gate");
  for (const [eng, r] of Object.entries(results)) {
    const pass = jitterGatePasses(r.jitter);
    console.log(
      `${eng.padEnd(11)} ${String(r.frameCount).padEnd(7)} ${r.jitter.hairJitterPx.toFixed(2).padEnd(13)} ` +
        `${r.jitter.torsoJitterPx.toFixed(2).padEnd(14)} ${r.jitter.jitterRatio.toFixed(2).padEnd(12)} ` +
        `${r.jitter.maxResidualP95Px.toFixed(2).padEnd(17)} ${pass ? "PASS" : "FAIL"}`,
    );
  }
  console.log(`gate (informational): jitterRatio <= ${HAIR_JITTER_RATIO_MAX} AND maxResidualP95Px < ${HAIR_JITTER_RESIDUAL_P95_MAX_PX}`);

  console.log("\n[PRIMARY] per-pixel temporal alpha variance — the blocking gate");
  console.log("engine      hairStd  torsoStd  ratio  gate");
  for (const [eng, r] of Object.entries(results)) {
    const pass = temporalAlphaGatePasses(r.temporal);
    console.log(
      `${eng.padEnd(11)} ${r.temporal.hairStd.toFixed(2).padEnd(8)} ${r.temporal.torsoStd.toFixed(2).padEnd(9)} ` +
        `${r.temporal.ratio.toFixed(2).padEnd(6)} ${pass ? "PASS" : "FAIL"}`,
    );
  }
  console.log(`gate: hairStd/torsoStd ratio <= ${HAIR_TEMPORAL_RATIO_MAX}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

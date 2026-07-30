import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCutoutPreview, extractCanvasFrames, matteFramesBatch } from "./generation/matte";
import {
  HAIR_TEMPORAL_RATIO_MAX,
  measureMaskJitterFromFrames,
  measureTemporalAlphaVarianceFromFrames,
  readGrayMaskSequence,
  temporalAlphaGatePasses,
} from "./generation/maskQC";
import { rvmAvailable, runRvmOnFrames } from "./generation/rvm";
import { measureHeadBBox, measureSubjectBBox } from "./generation/subjectFit";
import { PIPELINE_VERSION } from "./pipelineVersion";
import { FilledFormat, Format, MatteArtifact, MatteBlock, TrimPoints } from "./types";

/**
 * Module 3.4 — isolated video matting, run BEFORE the composite stage
 * (backgroundReplace.ts) so a matte's own quality (temporal stability,
 * framing) can be inspected and measured on its own — see
 * src/backend/pipeline/tools/matteProof.ts for the standalone version of
 * the same measurement, run against real footage before this stage
 * existed. compositeVideoOnBackdrop/compositeSubjectAlphaVideo consume
 * this stage's persisted masks (`precomputedMasksDir`) instead of running
 * Vision themselves, so the flattened composite and the fg-alpha layer
 * both matte from the SAME masks — no double Vision/RVM run per block, no
 * risk of the two layers drifting apart from engine non-determinism.
 *
 * Engine: RVM (recurrent, video-native — see generation/rvm.ts) when the
 * model file + onnxruntime-node are both available, else the existing
 * Vision path (generation/matte.ts's matteFramesBatch) plus a 3-frame
 * temporal median (`tmedian=radius=1`) — RVM's own recurrence already
 * provides temporal consistency, so the median only runs for the
 * fallback engine; stacking it on RVM's output would erode the fine hair
 * detail RVM was chosen for.
 *
 * Persists masks + the cut subclip only, not extracted frames — frames
 * are re-extracted deterministically from the persisted subclip wherever
 * they're needed downstream (identical `extractCanvasFrames` chain,
 * factored out so mask/frame alignment can't drift). Frames are ~1MB/PNG
 * at this canvas size; masks are far smaller (single-channel), so
 * skipping frame persistence keeps a job's disk footprint reasonable.
 *
 * Only measures — doesn't judge framing pass/fail (see qc.bodyLenHeadHeights'
 * own doc comment): the required-ratio threshold depends on the target
 * plate's deskEdgeFrac, which this stage has no plate to compare against.
 * backgroundReplace.ts's own calibrate step is where that solve (and its
 * bounded scale-up/shift-down/fail escalation) lives. This stage DOES
 * throw on the hair-stability gate, which has no such target-dependent
 * escape valve — a matte that fails it is simply not usable regardless of
 * how the composite stage would frame it.
 *
 * The hair-stability QC (jitter, temporal variance) is measured over an
 * EXTENDED window, not the block's own (often sub-2-second) span: a real
 * office block ran 1.2-4.4s in testing, and per-pixel temporal std over
 * that few frames is a noisy, duration-dependent statistic — a single
 * held pose has little genuine torso motion to measure, so the ratio's
 * denominator shrinks and the SAME footage/engine reads as unstable on a
 * short block that would pass comfortably over a longer window (measured:
 * RVM's ratio went from ~2-3 over 4-second windows to 3-15 over the
 * block's own 1-4 second span, even though the underlying masks were
 * visually identical in quality). QC_MIN_DURATION_SEC pulls extra context
 * from the SAME shared take (symmetric around the block's own span,
 * clamped to the take's actual bounds) purely to get a length-stable
 * measurement — the actual persisted subclip/masks used for compositing
 * are still cut to EXACTLY the block's own trim points, unaffected. */

const requestHash = (parts: Record<string, unknown>): string =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify({ ...parts, pipelineVersion: PIPELINE_VERSION }))
    .digest("hex")
    .slice(0, 16);

/** 0.375 is RVM's own guidance for HD-ish input; measured directly against
 *  real footage (this rework's Phase 1 proof) at both 0.25 and 0.375 —
 *  0.25 ran ~1.6x faster and measured equal-or-better on both the
 *  temporal-variance and boundary-jitter metrics, so it's the default
 *  rather than the model's own suggested starting point. */
const RVM_DOWNSAMPLE_RATIO = 0.25;

const countPngs = (dir: string): number =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".png")).length : 0;

/** sha256 over the sorted mask files' own bytes — cheap enough (single-
 *  channel PNGs) to hash directly rather than maintain a separate
 *  per-frame manifest, and it's what actually changes if the matte does. */
const maskDirHash = (masksDir: string): string => {
  const files = fs.readdirSync(masksDir).filter((f) => f.endsWith(".png")).sort();
  const hash = crypto.createHash("sha256");
  for (const f of files) hash.update(fs.readFileSync(path.join(masksDir, f)));
  return hash.digest("hex").slice(0, 16);
};

/** Minimum window length (seconds) the hair-stability QC measures over —
 *  see this file's own doc comment for why a block's own (often shorter)
 *  span produces an unreliable statistic. 8s (not 3s — measured directly:
 *  a 3s extension barely moved a real block's own ratio, since the extra
 *  ~1s of added context was still dominated by the same held, low-motion
 *  pose) errs toward "use nearly this user's whole take" for a typical
 *  ~10s single-take recording, since more genuine motion sampled is what
 *  actually stabilizes the statistic — not just more frames of a static
 *  pose. */
const QC_MIN_DURATION_SEC = 8.0;

/** Mattes a probe window of `sharedTake`, purely for QC measurement — see
 *  this file's own doc comment. Runs the SAME engine as the block's own
 *  matte, in a temp dir, never persisted. Falls back to the block's own
 *  (already-computed) masks when the take's duration is unknown or the
 *  block's own span already meets QC_MIN_DURATION_SEC. */
const readQcFrames = async (
  sharedTakeAbsPath: string,
  takeDurationSec: number | undefined,
  span: { srcInSec: number; srcOutSec: number },
  engine: "rvm" | "vision",
  format: Format,
  fallbackMasksDir: string,
): Promise<Buffer[]> => {
  const blockDurationSec = span.srcOutSec - span.srcInSec;
  if (takeDurationSec === undefined || blockDurationSec >= QC_MIN_DURATION_SEC) {
    return readGrayMaskSequence(fallbackMasksDir, format.width, format.height);
  }

  const extra = QC_MIN_DURATION_SEC - blockDurationSec;
  let qcStart = span.srcInSec - extra / 2;
  let qcEnd = span.srcOutSec + extra / 2;
  if (qcStart < 0) {
    qcEnd += -qcStart;
    qcStart = 0;
  }
  if (qcEnd > takeDurationSec) {
    qcStart -= qcEnd - takeDurationSec;
    qcEnd = takeDurationSec;
  }
  qcStart = Math.max(0, qcStart);
  qcEnd = Math.min(qcEnd, takeDurationSec);
  if (qcEnd - qcStart < blockDurationSec) {
    // Take itself is too short to extend at all — fall back rather than
    // shrink below the block's own span.
    return readGrayMaskSequence(fallbackMasksDir, format.width, format.height);
  }

  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-matte-qc-probe-"));
  try {
    const probeSubclip = path.join(probeDir, "probe.mp4");
    execFileSync("ffmpeg", [
      "-y", "-v", "error",
      "-ss", String(qcStart),
      "-i", sharedTakeAbsPath,
      "-t", String(qcEnd - qcStart),
      "-c:v", "libx264", "-c:a", "aac",
      probeSubclip,
    ]);

    const probeMasksDir = path.join(probeDir, "masks");
    fs.mkdirSync(probeMasksDir, { recursive: true });
    if (engine === "rvm") {
      await runRvmOnFrames(probeSubclip, probeMasksDir, {
        width: format.width,
        height: format.height,
        fps: format.fps,
        downsampleRatio: RVM_DOWNSAMPLE_RATIO,
      });
    } else {
      const rawFramesDir = path.join(probeDir, "frames-tmp");
      const rawMasksDir = path.join(probeDir, "masks-raw");
      fs.mkdirSync(rawFramesDir, { recursive: true });
      extractCanvasFrames(probeSubclip, rawFramesDir, { width: format.width, height: format.height, fps: format.fps });
      matteFramesBatch(rawFramesDir, rawMasksDir);
      execFileSync("ffmpeg", [
        "-y", "-v", "error",
        "-framerate", String(format.fps),
        "-i", path.join(rawMasksDir, "f%05d.png"),
        "-vf", "tmedian=radius=1",
        path.join(probeMasksDir, "f%05d.png"),
      ]);
    }
    return readGrayMaskSequence(probeMasksDir, format.width, format.height);
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
};

export const runMatte = async (format: Format, filled: FilledFormat, trims: TrimPoints): Promise<MatteArtifact> => {
  const flagged = format.blocks.filter((b) => b.backgroundReplace);
  if (flagged.length === 0) return { formatId: format.id, blocks: [] };

  const takeSlot = format.speakingTakeSlot;
  if (!takeSlot) throw new Error("runMatte: format has backgroundReplace blocks but no speakingTakeSlot");
  const sharedTake = filled.bindings[takeSlot.name];
  if (sharedTake?.type !== "file") {
    throw new Error(`runMatte: speakingTakeSlot "${takeSlot.name}" is not bound to a file`);
  }

  const matteDir = path.join(filled.jobDir, "generated", "matte");
  fs.mkdirSync(matteDir, { recursive: true });

  const engine: "rvm" | "vision" = rvmAvailable() ? "rvm" : "vision";
  console.log(`  matte: engine=${engine}${engine === "vision" ? " (RVM model/runtime unavailable — see generation/rvm.ts's requireRvmModel)" : ""}`);

  const blocks: MatteBlock[] = [];
  for (const block of flagged) {
    const trimEntry = trims.blocks.find((b) => b.blockId === block.id);
    if (!trimEntry) throw new Error(`runMatte: no trim entry for block "${block.id}"`);
    const [span] = trimEntry.takes;

    const blockDir = path.join(matteDir, block.videoSlot);
    fs.mkdirSync(blockDir, { recursive: true });
    const subclipPath = path.join(blockDir, "subclip.mp4");
    const masksDir = path.join(blockDir, "masks");
    const previewPath = path.join(blockDir, "preview.mov");
    const hashFile = path.join(blockDir, ".hash");

    const hash = requestHash({
      takeAbsPath: sharedTake.absPath,
      srcInSec: span.srcInSec,
      srcOutSec: span.srcOutSec,
      engine,
      downsampleRatio: engine === "rvm" ? RVM_DOWNSAMPLE_RATIO : undefined,
      fps: format.fps,
      width: format.width,
      height: format.height,
    });
    const cachedHash = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, "utf8") : undefined;
    const cacheValid = cachedHash === hash && fs.existsSync(subclipPath) && countPngs(masksDir) > 0;

    if (!cacheValid) {
      execFileSync("ffmpeg", [
        "-y", "-v", "error",
        "-ss", String(span.srcInSec),
        "-i", sharedTake.absPath,
        "-t", String(span.srcOutSec - span.srcInSec),
        "-c:v", "libx264", "-c:a", "aac",
        subclipPath,
      ]);

      fs.rmSync(masksDir, { recursive: true, force: true });
      fs.mkdirSync(masksDir, { recursive: true });

      if (engine === "rvm") {
        await runRvmOnFrames(subclipPath, masksDir, {
          width: format.width,
          height: format.height,
          fps: format.fps,
          downsampleRatio: RVM_DOWNSAMPLE_RATIO,
        });
      } else {
        const rawFramesDir = path.join(blockDir, "frames-tmp");
        const rawMasksDir = path.join(blockDir, "masks-raw");
        fs.rmSync(rawFramesDir, { recursive: true, force: true });
        fs.mkdirSync(rawFramesDir, { recursive: true });
        extractCanvasFrames(subclipPath, rawFramesDir, { width: format.width, height: format.height, fps: format.fps });
        matteFramesBatch(rawFramesDir, rawMasksDir);
        execFileSync("ffmpeg", [
          "-y", "-v", "error",
          "-framerate", String(format.fps),
          "-i", path.join(rawMasksDir, "f%05d.png"),
          "-vf", "tmedian=radius=1",
          path.join(masksDir, "f%05d.png"),
        ]);
        fs.rmSync(rawFramesDir, { recursive: true, force: true });
        fs.rmSync(rawMasksDir, { recursive: true, force: true });
      }

      // Preview frames are extracted fresh and discarded — this stage
      // never persists extracted frames itself (see this file's own doc
      // comment).
      const previewFramesDir = path.join(blockDir, "frames-tmp");
      fs.rmSync(previewFramesDir, { recursive: true, force: true });
      fs.mkdirSync(previewFramesDir, { recursive: true });
      extractCanvasFrames(subclipPath, previewFramesDir, { width: format.width, height: format.height, fps: format.fps });
      const previewFrameCount = Math.min(countPngs(previewFramesDir), countPngs(masksDir));
      buildCutoutPreview(previewFramesDir, masksDir, previewFrameCount, format.width, format.height, format.fps, previewPath);
      fs.rmSync(previewFramesDir, { recursive: true, force: true });

      fs.writeFileSync(hashFile, hash);
    }

    const frameCount = countPngs(masksDir);
    const subjectBBox = measureSubjectBBox(masksDir, format.width, format.height);
    const headBBox = measureHeadBBox(masksDir, format.width, format.height);

    // Framing (bbox) always comes from the block's OWN masks — only the
    // temporal QC below needs the extended window (see readQcFrames' own
    // doc comment).
    const qcFrames = await readQcFrames(sharedTake.absPath, sharedTake.durationSec, span, engine, format, masksDir);
    const jitter = headBBox
      ? measureMaskJitterFromFrames(qcFrames, format.width, format.height, headBBox)
      : { hairJitterPx: 0, torsoJitterPx: 0, jitterRatio: 0, maxResidualP95Px: 0 };
    const temporal = headBBox && subjectBBox
      ? measureTemporalAlphaVarianceFromFrames(qcFrames, format.width, format.height, headBBox, subjectBBox)
      : { hairStd: 0, torsoStd: 0, ratio: 0 };

    const bodyLenHeadHeights = headBBox && subjectBBox
      ? (subjectBBox.bottomFrac - headBBox.topFrac) / Math.max(0.001, headBBox.bottomFrac - headBBox.topFrac)
      : undefined;

    console.log(
      `    ${block.id}/${block.videoSlot}: ${frameCount} frames, temporal ratio ${temporal.ratio.toFixed(2)} ` +
        `(hairStd=${temporal.hairStd.toFixed(1)} torsoStd=${temporal.torsoStd.toFixed(1)}), ` +
        `jitter ratio ${jitter.jitterRatio.toFixed(2)} [informational]` +
        (bodyLenHeadHeights !== undefined ? `, body ${bodyLenHeadHeights.toFixed(2)} head-heights below crown` : ""),
    );

    if (headBBox && !temporalAlphaGatePasses(temporal)) {
      throw new Error(
        `runMatte: hair-stability gate failed for block "${block.id}" (${block.videoSlot}) — ` +
          `temporal alpha ratio ${temporal.ratio.toFixed(2)} exceeds ${HAIR_TEMPORAL_RATIO_MAX} ` +
          `(hairStd=${temporal.hairStd.toFixed(2)}, torsoStd=${temporal.torsoStd.toFixed(2)}, engine=${engine})`,
      );
    }

    blocks.push({
      blockId: block.id,
      videoSlot: block.videoSlot,
      subclipPath: path.relative(filled.jobDir, subclipPath),
      masksDir: path.relative(filled.jobDir, masksDir),
      previewPath: path.relative(filled.jobDir, previewPath),
      frameCount,
      fps: format.fps,
      width: format.width,
      height: format.height,
      engine,
      downsampleRatio: engine === "rvm" ? RVM_DOWNSAMPLE_RATIO : undefined,
      subjectBBoxFrac: subjectBBox,
      headBBoxFrac: headBBox,
      masksHash: maskDirHash(masksDir),
      qc: {
        hairJitterPx: jitter.hairJitterPx,
        torsoJitterPx: jitter.torsoJitterPx,
        jitterRatio: jitter.jitterRatio,
        maxResidualP95Px: jitter.maxResidualP95Px,
        hairTemporalStd: temporal.hairStd,
        torsoTemporalStd: temporal.torsoStd,
        temporalRatio: temporal.ratio,
        bodyLenHeadHeights,
      },
    });
  }

  return { formatId: format.id, blocks };
};

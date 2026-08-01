import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireWhisperModel, transcribeFile } from "../pipeline/whisper";
import { authoringDir } from "../pipeline/paths";
import { Analysis, DenseFrame, Shot } from "./types";

/**
 * Module A2 — Analyze.
 * Turns one reference clip into the raw material the synthesis step
 * reasons over: a word-level transcript (reused whisper.cpp path), shot
 * boundaries (ffmpeg scene detection), one representative frame per shot,
 * and a DENSER set of sampled frames for visual choreography (overlay
 * position/reveal/color changes) that happens WITHIN a single shot — a
 * continuous-take reel can have just 1-2 shots yet dozens of distinct
 * on-screen visual states, which the shot list alone can never surface.
 */

/** ffmpeg's per-frame scene-change score (0..1); higher = more selective. */
const SCENE_THRESHOLD = 0.3;
/** Hard cap on shots analyzed — bounds frame-sampling/synthesis cost against
 *  a pathological source (rapid-cut or flash-heavy footage). */
const MAX_SHOTS = 40;
/** Much more sensitive than SCENE_THRESHOLD — this isn't looking for hard
 *  cuts, it's looking for a subtler visual change (an overlay popping in,
 *  a blur->sharp reveal, a color swap) while the shot itself stays put. */
const DENSE_CHANGE_THRESHOLD = 0.08;
/** A shot with no detected change points still gets baseline coverage —
 *  no gap in the sampled timeline wider than this. */
const MIN_DENSE_GAP_SEC = 1.0;
/** Bounds synthesis cost against a long/fast-cut source, same spirit as
 *  MAX_SHOTS — downsampled evenly (see downsampleEvenly), not truncated. */
const MAX_DENSE_FRAMES = 48;
/** Two candidate timestamps this close together are treated as one. */
const DEDUPE_EPS_SEC = 0.15;
const FRAME_WIDTH = 480;

/** Downsample evenly (not truncate) so later material isn't silently
 *  dropped when a list is over a cap. */
const downsampleEvenly = <T>(items: T[], max: number): T[] => {
  if (items.length <= max) return items;
  const stride = items.length / max;
  return Array.from({ length: max }, (_, i) => items[Math.floor(i * stride)]);
};

/** Visual-change timestamps via ffmpeg's `select`+`showinfo` filter, at a
 *  caller-chosen sensitivity. Unlike execFileSync, spawnSync surfaces
 *  stderr (where showinfo logs land) even on a normal (zero) exit. */
const detectChangeTimes = (sourcePath: string, threshold: number): number[] => {
  const result = spawnSync(
    "ffmpeg",
    ["-i", sourcePath, "-filter:v", `select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`analyze: ffmpeg change detection failed:\n${(result.stderr ?? "").slice(-2000)}`);
  }
  const times: number[] = [];
  for (const match of result.stderr.matchAll(/pts_time:([\d.]+)/g)) {
    times.push(Number(match[1]));
  }
  return times;
};

/** Boundaries [0, ...sceneChanges, duration] → contiguous shots, downsampled
 *  to MAX_SHOTS (evenly) if scene detection over-fires. */
const buildShots = (sceneChangeTimes: number[], durationSec: number): Array<{ startSec: number; endSec: number }> => {
  const bounds = [0, ...sceneChangeTimes.filter((t) => t > 0 && t < durationSec), durationSec].sort(
    (a, b) => a - b,
  );
  const unique = bounds.filter((t, i) => i === 0 || t - bounds[i - 1] > 0.05);
  const rawShots = unique.slice(0, -1).map((start, i) => ({ startSec: start, endSec: unique[i + 1] }));
  return downsampleEvenly(rawShots, MAX_SHOTS);
};

/** Every timestamp worth sampling a frame at for dense visual analysis:
 *  low-threshold change points (catches an overlay reveal a hard-cut
 *  detector would never fire on) unioned with an evenly-spaced grid (so a
 *  visually static stretch still gets baseline coverage), deduped and
 *  capped. */
const buildDenseTimestamps = (denseChangeTimes: number[], durationSec: number): number[] => {
  const grid: number[] = [];
  for (let t = 0; t < durationSec; t += MIN_DENSE_GAP_SEC) grid.push(t);
  const merged = [...denseChangeTimes.filter((t) => t >= 0 && t < durationSec), ...grid].sort((a, b) => a - b);
  const deduped = merged.filter((t, i) => i === 0 || t - merged[i - 1] > DEDUPE_EPS_SEC);
  return downsampleEvenly(deduped, MAX_DENSE_FRAMES);
};

const extractFrame = (sourcePath: string, atSec: number, outPath: string): boolean => {
  try {
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-ss",
        atSec.toFixed(3),
        "-i",
        sourcePath,
        "-frames:v",
        "1",
        "-vf",
        `scale=${FRAME_WIDTH}:-2`,
        "-q:v",
        "3",
        outPath,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    return fs.existsSync(outPath);
  } catch {
    return false;
  }
};

export const analyze = (
  draftId: string,
  sourcePath: string,
  sourceUrl: string,
  durationSec: number,
  width: number,
  height: number,
): Analysis => {
  requireWhisperModel();
  const dir = authoringDir(draftId);
  const framesDir = path.join(dir, "frames");
  fs.mkdirSync(framesDir, { recursive: true });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-authoring-"));
  let words: Analysis["words"];
  try {
    words = transcribeFile(sourcePath, workDir);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  if (words.length === 0) {
    console.warn(`analyze: no speech detected in ${sourcePath} — the draft's anchors will be weak`);
  }

  const sceneChangeTimes = detectChangeTimes(sourcePath, SCENE_THRESHOLD);
  const rawShots = buildShots(sceneChangeTimes, durationSec);

  const shots: Shot[] = [];
  rawShots.forEach((s, i) => {
    const midSec = (s.startSec + s.endSec) / 2;
    const frameName = `frame_${String(i).padStart(3, "0")}.jpg`;
    const ok = extractFrame(sourcePath, midSec, path.join(framesDir, frameName));
    if (!ok) {
      console.warn(`analyze: failed to extract frame for shot ${i} at ${midSec.toFixed(2)}s — skipping`);
      return;
    }
    shots.push({ index: i, startSec: s.startSec, endSec: s.endSec, frame: `frames/${frameName}` });
  });

  const denseChangeTimes = detectChangeTimes(sourcePath, DENSE_CHANGE_THRESHOLD);
  const denseTimestamps = buildDenseTimestamps(denseChangeTimes, durationSec);

  const denseFrames: DenseFrame[] = [];
  denseTimestamps.forEach((atSec, i) => {
    const frameName = `dense_${String(i).padStart(3, "0")}.jpg`;
    const ok = extractFrame(sourcePath, atSec, path.join(framesDir, frameName));
    if (!ok) {
      console.warn(`analyze: failed to extract dense frame at ${atSec.toFixed(2)}s — skipping`);
      return;
    }
    denseFrames.push({ atSec, frame: `frames/${frameName}` });
  });

  return { sourceUrl, durationSec, width, height, words, shots, denseFrames };
};

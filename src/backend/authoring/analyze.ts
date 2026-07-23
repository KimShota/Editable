import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireWhisperModel, transcribeFile } from "../pipeline/whisper";
import { authoringDir } from "../pipeline/paths";
import { Analysis, Shot } from "./types";

/**
 * Module A2 — Analyze.
 * Turns one reference clip into the raw material the synthesis step
 * reasons over: a word-level transcript (reused whisper.cpp path), shot
 * boundaries (ffmpeg scene detection), and one representative frame per
 * shot (for multimodal reasoning about on-screen text/overlays/memes,
 * which the transcript alone can't see).
 */

/** ffmpeg's per-frame scene-change score (0..1); higher = more selective. */
const SCENE_THRESHOLD = 0.3;
/** Hard cap on shots analyzed — bounds frame-sampling/synthesis cost against
 *  a pathological source (rapid-cut or flash-heavy footage). */
const MAX_SHOTS = 40;
const FRAME_WIDTH = 480;

/** Scene-change timestamps via ffmpeg's `select`+`showinfo` filter. Unlike
 *  execFileSync, spawnSync surfaces stderr (where showinfo logs land) even
 *  on a normal (zero) exit. */
const detectSceneChangeTimes = (sourcePath: string): number[] => {
  const result = spawnSync(
    "ffmpeg",
    ["-i", sourcePath, "-filter:v", `select='gt(scene,${SCENE_THRESHOLD})',showinfo`, "-f", "null", "-"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`analyze: ffmpeg scene detection failed:\n${(result.stderr ?? "").slice(-2000)}`);
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

  if (rawShots.length <= MAX_SHOTS) return rawShots;
  // Downsample evenly rather than just truncating, so late-video shots
  // aren't silently dropped.
  const stride = rawShots.length / MAX_SHOTS;
  return Array.from({ length: MAX_SHOTS }, (_, i) => rawShots[Math.floor(i * stride)]);
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

  const sceneChangeTimes = detectSceneChangeTimes(sourcePath);
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

  return { sourceUrl, durationSec, width, height, words, shots };
};

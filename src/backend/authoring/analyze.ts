import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireWhisperModel, transcribeFile } from "../pipeline/whisper";
import { authoringDir } from "../pipeline/paths";
import { buildShots, detectChangeTimes, downsampleEvenly, extractFrame } from "../pipeline/shotDetect";
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

const buildShotsCapped = (changeTimes: number[], durationSec: number) => buildShots(changeTimes, durationSec, MAX_SHOTS);

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
  const rawShots = buildShotsCapped(sceneChangeTimes, durationSec);

  const shots: Shot[] = [];
  rawShots.forEach((s, i) => {
    const midSec = (s.startSec + s.endSec) / 2;
    const frameName = `frame_${String(i).padStart(3, "0")}.jpg`;
    const ok = extractFrame(sourcePath, midSec, path.join(framesDir, frameName), FRAME_WIDTH);
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
    const ok = extractFrame(sourcePath, atSec, path.join(framesDir, frameName), FRAME_WIDTH);
    if (!ok) {
      console.warn(`analyze: failed to extract dense frame at ${atSec.toFixed(2)}s — skipping`);
      return;
    }
    denseFrames.push({ atSec, frame: `frames/${frameName}` });
  });

  return { sourceUrl, durationSec, width, height, words, shots, denseFrames };
};

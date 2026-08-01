import { spawnSync } from "node:child_process";

/**
 * Mean structural similarity (0-1, higher = more similar) between matching
 * [inSec, inSec+durationSec) windows of two video files, normalized to the
 * same size/fps before comparing — via ffmpeg's own `ssim` filter. No new
 * npm dependency: consistent with this codebase's existing convention of
 * shelling out to ffmpeg for all image/video analysis (see analyze.ts,
 * buildTemplateAssets.ts's imageLumaStats).
 *
 * Unlike the rest of this codebase's ffmpeg calls, this one deliberately
 * does NOT pass `-v error` — the ssim filter logs its per-frame values
 * (and, at the very end, the whole-stream AVERAGE in the same "All:X"
 * format) at the INFO level, which `-v error` would silence entirely.
 */
export const measureSsim = (
  fileA: string,
  inSecA: number,
  fileB: string,
  inSecB: number,
  durationSec: number,
  width: number,
  height: number,
  fps: number,
): number => {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "info",
      "-ss",
      inSecA.toFixed(3),
      "-t",
      durationSec.toFixed(3),
      "-i",
      fileA,
      "-ss",
      inSecB.toFixed(3),
      "-t",
      durationSec.toFixed(3),
      "-i",
      fileB,
      "-lavfi",
      `[0:v]scale=${width}:${height},fps=${fps}[a];[1:v]scale=${width}:${height},fps=${fps}[b];[a][b]ssim`,
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`measureSsim: ffmpeg failed:\n${(result.stderr ?? "").slice(-2000)}`);
  }
  // The FINAL "All:" match is the filter's own whole-stream average
  // (logged once in its uninit, after every per-frame line) — not a
  // per-frame instantaneous value.
  const matches = [...result.stderr.matchAll(/All:([\d.]+)/g)];
  const last = matches[matches.length - 1];
  if (!last) {
    throw new Error(`measureSsim: no SSIM "All:" value found in ffmpeg output:\n${result.stderr.slice(-1000)}`);
  }
  return Number(last[1]);
};

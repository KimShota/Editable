import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";

/**
 * Shared shot-boundary / frame-sampling primitives — originally written
 * for authoring/analyze.ts (reverse-engineering a reference reel) and
 * reused as-is by discover.ts (finding beat boundaries in a user's own
 * long take). Both are the same underlying problem: "where do the visual
 * cuts fall in this file, and what does it look like at each one" — only
 * what the CALLER does with the shot list differs.
 */

/** Downsample evenly (not truncate) so later material isn't silently
 *  dropped when a list is over a cap. */
export const downsampleEvenly = <T>(items: T[], max: number): T[] => {
  if (items.length <= max) return items;
  const stride = items.length / max;
  return Array.from({ length: max }, (_, i) => items[Math.floor(i * stride)]);
};

/** Visual-change timestamps via ffmpeg's `select`+`showinfo` filter, at a
 *  caller-chosen sensitivity. Unlike execFileSync, spawnSync surfaces
 *  stderr (where showinfo logs land) even on a normal (zero) exit. */
export const detectChangeTimes = (sourcePath: string, threshold: number): number[] => {
  const result = spawnSync(
    "ffmpeg",
    ["-i", sourcePath, "-filter:v", `select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`shotDetect: ffmpeg change detection failed:\n${(result.stderr ?? "").slice(-2000)}`);
  }
  const times: number[] = [];
  for (const match of result.stderr.matchAll(/pts_time:([\d.]+)/g)) {
    times.push(Number(match[1]));
  }
  return times;
};

/** Boundaries [0, ...changeTimes, duration] → contiguous shots, downsampled
 *  to `maxShots` (evenly) if change detection over-fires. */
export const buildShots = (
  changeTimes: number[],
  durationSec: number,
  maxShots: number,
): Array<{ startSec: number; endSec: number }> => {
  const bounds = [0, ...changeTimes.filter((t) => t > 0 && t < durationSec), durationSec].sort((a, b) => a - b);
  const unique = bounds.filter((t, i) => i === 0 || t - bounds[i - 1] > 0.05);
  const rawShots = unique.slice(0, -1).map((start, i) => ({ startSec: start, endSec: unique[i + 1] }));
  return downsampleEvenly(rawShots, maxShots);
};

/** Extracts one JPEG frame at `atSec`, scaled to `frameWidth` wide.
 *  Returns false (never throws) on failure so a caller can skip/warn
 *  rather than abort a whole batch over one bad seek. */
export const extractFrame = (sourcePath: string, atSec: number, outPath: string, frameWidth = 480): boolean => {
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
        `scale=${frameWidth}:-2`,
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

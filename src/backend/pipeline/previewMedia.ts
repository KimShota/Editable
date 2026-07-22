import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

/**
 * On-demand preview media for the browser editor only — never touches the
 * export path (render.ts feeds Remotion the original sources directly).
 *
 * The editor's Remotion <Player> has to live-decode whatever it's given,
 * unlike a render (which extracts frames offthread). Source footage here is
 * routinely 4K/40+ Mbps phone video shown at a few hundred px wide, so the
 * browser was decoding far more than it displays. These helpers produce a
 * small cached proxy (downscaled video, or a single poster frame) next to
 * the original, generated once and reused after.
 */

const execFileAsync = promisify(execFile);

/** Concurrent requests for the same not-yet-cached asset share one ffmpeg
 *  run instead of racing separate ones (and corrupting each other's output). */
const inFlight = new Map<string, Promise<void>>();

const isFresh = (cacheAbsPath: string, sourceAbsPath: string): boolean =>
  fs.existsSync(cacheAbsPath) &&
  fs.statSync(cacheAbsPath).mtimeMs >= fs.statSync(sourceAbsPath).mtimeMs;

/** Writes to a per-process tmp path and renames into place, so a concurrent
 *  reader can never observe a partially-written cache file. The tmp name
 *  keeps the real extension — ffmpeg picks its output muxer from the
 *  filename, so a suffixed-away extension fails with "Unable to choose an
 *  output format". */
const runFfmpeg = async (cacheAbsPath: string, args: string[]): Promise<void> => {
  const dir = path.dirname(cacheAbsPath);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(cacheAbsPath);
  const base = path.basename(cacheAbsPath, ext);
  const tmpPath = path.join(dir, `${base}.tmp-${process.pid}-${Date.now()}${ext}`);
  try {
    await execFileAsync("ffmpeg", [...args, tmpPath]);
    fs.renameSync(tmpPath, cacheAbsPath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
};

const dedupe = (key: string, fn: () => Promise<void>): Promise<void> => {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
};

/**
 * Downscaled, heavily-compressed stand-in for a video source, used only by
 * the live preview Player. ffmpeg auto-applies any rotation side-data (the
 * common case for phone footage shot portrait) before scaling, so the
 * output is upright with no rotation metadata for the browser to interpret.
 */
export const ensurePreviewProxy = (sourceAbsPath: string, cacheAbsPath: string): Promise<void> => {
  if (isFresh(cacheAbsPath, sourceAbsPath)) return Promise.resolve();
  return dedupe(cacheAbsPath, () =>
    runFfmpeg(cacheAbsPath, [
      "-y",
      "-i",
      sourceAbsPath,
      "-vf",
      "scale=-2:960:force_original_aspect_ratio=decrease",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "26",
      "-maxrate",
      "3M",
      "-bufsize",
      "6M",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
    ]),
  );
};

/** A single poster frame — replaces mounting a live <video> per clip in the
 *  media panel, which otherwise competes with the Player for decoders. */
export const ensurePreviewThumbnail = (
  sourceAbsPath: string,
  cacheAbsPath: string,
  atSec: number,
): Promise<void> => {
  if (isFresh(cacheAbsPath, sourceAbsPath)) return Promise.resolve();
  return dedupe(cacheAbsPath, () =>
    runFfmpeg(cacheAbsPath, [
      "-y",
      "-ss",
      String(Math.max(0, atSec)),
      "-i",
      sourceAbsPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=480:-2",
      "-q:v",
      "4",
    ]),
  );
};

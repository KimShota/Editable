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

/**
 * Caps how many ffmpeg processes this server runs at once, across every
 * caller below (preview proxy, thumbnail, and the .mov compat transcode).
 * Without this, the editor's own prewarm (see Editor.tsx's
 * warmedPreviewSources effect, which fires one preview-proxy request per
 * video source in the EDL as soon as it loads — every clip, not just the
 * one on screen) launches one ffmpeg per source simultaneously. They'd all
 * compete for the same CPU and finish slowly together, instead of the
 * clip actually about to play finishing first. 2 leaves headroom for the
 * Node process itself (request handling, and a render's own headless-
 * Chromium + ffmpeg work if one happens to be running) rather than handing
 * every core to preview transcodes.
 */
const MAX_CONCURRENT_FFMPEG = 2;
let activeFfmpeg = 0;
const ffmpegWaiters: Array<() => void> = [];

const acquireFfmpegSlot = (): Promise<void> => {
  if (activeFfmpeg < MAX_CONCURRENT_FFMPEG) {
    activeFfmpeg++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => ffmpegWaiters.push(resolve));
};

/** Hands the freed slot straight to the next waiter instead of
 *  decrementing-then-incrementing — same net effect, but as one
 *  synchronous step so there's no in-between state where the slot looks
 *  available to something outside this queue. */
const releaseFfmpegSlot = (): void => {
  const next = ffmpegWaiters.shift();
  if (next) next();
  else activeFfmpeg--;
};

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
  await acquireFfmpegSlot();
  try {
    await execFileAsync("ffmpeg", [...args, tmpPath]);
    fs.renameSync(tmpPath, cacheAbsPath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  } finally {
    releaseFfmpegSlot();
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
      "scale=-2:960:force_original_aspect_ratio=decrease:force_divisible_by=2",
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

/**
 * Container/codec-compat transcode for a raw .mov, used by the generic
 * /api/media/[...path] route: Chrome's <video> element doesn't reliably
 * play "video/quicktime" even when the underlying codec (typically H.264)
 * would otherwise work fine, so this re-muxes/re-encodes once to an
 * ordinary H.264/AAC mp4 (no downscaling — unlike ensurePreviewProxy,
 * a browser may hit this for a full-quality view, e.g. a resources
 * dropzone thumbnail's source or a draft review's reference reel).
 * Cached alongside the source; every later request just serves the cache.
 * Same isFresh/dedupe/runFfmpeg machinery as the two helpers above, so it
 * shares their concurrency cap and never blocks the Node event loop —
 * this used to shell out via execFileSync, which froze request handling
 * for every other user on the server for the whole transcode.
 */
export const ensureMovCompatTranscode = (sourceAbsPath: string, cacheAbsPath: string): Promise<void> => {
  if (isFresh(cacheAbsPath, sourceAbsPath)) return Promise.resolve();
  return dedupe(cacheAbsPath, () =>
    runFfmpeg(cacheAbsPath, [
      "-y",
      "-v",
      "error",
      "-i",
      sourceAbsPath,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
    ]),
  );
};

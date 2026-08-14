import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { publicDir, repoRoot } from "@backend/pipeline/paths";
import { ensureMovCompatTranscode } from "@backend/pipeline/previewMedia";

/**
 * Generic file streamer for content that lives outside public/ (which Next
 * only serves as-is): rendered videos in out/, a job's own uploaded assets
 * in jobs/<id>/assets/, library/ assets, an authoring draft's reference
 * reel in authoring/<draftId>/, and a format's own checked-in template
 * assets in formats/assets/<formatId>/ (e.g. a slot's defaultAsset — see
 * SlotSchema). One route covers all of these so every page — gallery
 * preview, resources dropzone thumbnail, editor player, library grid,
 * draft review's verify comparison — can just point an
 * <video>/<img>/<audio> src here.
 *
 * URL shape: /api/media/<root>/<...rest>, root ∈ out | jobs | library | authoring | formats
 * | public-jobs.
 *
 * `public-jobs` is distinct from `jobs`: `jobs` resolves under repoRoot/jobs
 * (a job's original, unstaged files), while `public-jobs` resolves under
 * publicDir/jobs — the copies stageAssets() stages for Remotion/the browser,
 * plus the preview-proxy/-thumbnail ffmpeg caches, none of which exist under
 * repoRoot/jobs. next.config.mjs's afterFiles rewrite sends any
 * /jobs/<id>/{assets,generated,derived}/... request here whenever Next's own
 * (boot-time-snapshotted) public folder serving 404s on it — see that
 * rewrite's own comment for why the snapshot goes stale.
 */

const ALLOWED_ROOTS = new Set(["out", "jobs", "library", "authoring", "formats", "public-jobs"]);

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".json": "application/json",
};

/** Parses a "bytes=start-end" Range header against a known file size, per
 *  RFC 7233 §2.1 (open-ended and suffix forms included). Returns null for
 *  anything absent or unsatisfiable, in which case callers fall back to
 *  serving the whole file. */
function parseRange(rangeHeader: string | null, size: number): { start: number; end: number } | null {
  const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader) : null;
  if (!match) return null;
  const [, startStr, endStr] = match;
  if (!startStr && !endStr) return null;

  let start: number;
  let end: number;
  if (!startStr) {
    // Suffix range: last N bytes.
    start = Math.max(size - parseInt(endStr, 10), 0);
    end = size - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr ? Math.min(parseInt(endStr, 10), size - 1) : size - 1;
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

/** Cheap enough to compute on every request (just the already-`stat`'d
 *  size/mtime, no file read) — weak because a byte-identical re-encode at
 *  the same size+mtime-granularity is indistinguishable from the original
 *  and that's fine for video/audio, unlike e.g. a JSON diff. */
const weakETag = (stat: fs.Stats): string => `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;

/** Serves a file with Range support — required for <video>/<audio> seeking
 *  to work at all in Chrome. Without a 206 response to a Range request, the
 *  element treats the resource as unseekable and setting `currentTime` is
 *  silently ignored.
 *
 * Streams via fs.createReadStream instead of reading the whole file into a
 * Buffer first — a scrub/seek on a multi-hundred-MB clip used to allocate
 * the ENTIRE file per request (a 326MB source for a 64KB range read), and
 * every one of those buffers stays pinned in RAM for as long as its
 * response is in flight; a handful of concurrent video elements on one
 * page was enough to push the dev server into the multi-GB range. Streaming
 * caps memory at whatever the platform's own internal chunk size is,
 * regardless of file size.
 *
 * Defaults to `Cache-Control: no-cache` (NOT no-store, and NOT a long
 * max-age/immutable): out/<jobId>.mp4 gets overwritten by a re-render at
 * the SAME path, and a job's own assets/generated/derived files can
 * likewise be replaced without a path change (see stageAssets/the ffmpeg
 * transcode below) — so by default this always revalidates with the
 * server rather than trusting a local copy indefinitely. Revalidation is a
 * 304 (via ETag/Last-Modified) that costs one stat() call, not a re-read,
 * which is what actually kills the redundant-refetch half of the memory
 * problem: the browser's own cache serves the bytes it already downloaded
 * instead of re-requesting them from a route that used to advertise itself
 * as uncacheable.
 *
 * `cacheControl` lets a caller opt OUT of that default for paths it can
 * prove are safe to cache indefinitely — currently only the "public-jobs"
 * root's own `_previews/` files (see the GET handler below), whose
 * filenames are content-addressed by previewCachePath specifically so an
 * immutable cache is safe: a changed source produces a different URL
 * rather than changed bytes at the same one. */
function serveFile(filePath: string, contentType: string, req: NextRequest, cacheControl = "no-cache"): NextResponse {
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const etag = weakETag(stat);
  const lastModified = stat.mtime.toUTCString();

  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag, "Last-Modified": lastModified, "Cache-Control": cacheControl } });
  }

  const range = parseRange(req.headers.get("range"), size);
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;

  const nodeStream = fs.createReadStream(filePath, { start, end });
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(end - start + 1),
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
    ETag: etag,
    "Last-Modified": lastModified,
  };
  if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;

  return new NextResponse(webStream, { status: range ? 206 : 200, headers });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const segments = (await params).path;
  const [root, ...rest] = segments;
  if (!root || !ALLOWED_ROOTS.has(root) || rest.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const rootDir = root === "public-jobs" ? path.join(publicDir, "jobs") : path.join(repoRoot, root);
  const resolved = path.join(rootDir, ...rest);

  // Reject any traversal outside the resolved root, however it got encoded.
  if (!resolved.startsWith(rootDir + path.sep) && resolved !== rootDir) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Chrome's <video> element doesn't reliably play "video/quicktime" even
  // when the underlying codec (typically H.264) would otherwise work fine
  // — and raw phone footage is almost always .mov. Rather than serve the
  // original (which silently fails to play in-browser, looking exactly
  // like "the file is broken"), transcode once to an ordinary H.264/AAC
  // mp4 and cache it alongside the source; every later request for the
  // same file just serves the cached copy. The pipeline itself (whisper,
  // ffmpeg render) always reads the ORIGINAL .mov directly via its own
  // absolute path — this only affects what a browser <video>/<audio> tag
  // is served, never what intake/transcribe/assemble operate on.
  //
  // ensureMovCompatTranscode runs ffmpeg via execFile (async), not
  // execFileSync — this used to block the ENTIRE server's event loop for
  // every other request in flight, for the whole transcode. It also
  // shares previewMedia.ts's per-source dedupe and process-wide ffmpeg
  // concurrency cap with the preview-proxy/-thumbnail routes.
  if (path.extname(resolved).toLowerCase() === ".mov") {
    const previewPath = `${resolved}.preview.mp4`;
    try {
      await ensureMovCompatTranscode(resolved, previewPath);
    } catch (err) {
      console.error(`media route: .mov transcode failed for ${resolved}`, err);
      // Fall through and serve the original as-is rather than 500 — a
      // corrupt source or missing ffmpeg shouldn't take the whole request
      // down when the raw file itself is still readable.
    }
    if (fs.existsSync(previewPath)) {
      return serveFile(previewPath, "video/mp4", req);
    }
  }

  // See serveFile's own doc comment: only public-jobs' own _previews/
  // files are content-addressed (by previewCachePath) and therefore safe
  // to hand a browser as `immutable` — this is the fallback route's half
  // of that; next.config.mjs's headers() sets the same value for when
  // Next serves the identical URL natively (no restart needed) instead of
  // through this route.
  const isImmutablePreviewCache = root === "public-jobs" && resolved.includes(`${path.sep}_previews${path.sep}`);
  const contentType = CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
  return serveFile(resolved, contentType, req, isImmutablePreviewCache ? "public, max-age=31536000, immutable" : undefined);
}

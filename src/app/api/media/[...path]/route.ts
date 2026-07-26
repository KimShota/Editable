import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { repoRoot } from "@backend/pipeline/paths";

/**
 * Generic file streamer for content that lives outside public/ (which Next
 * only serves as-is): rendered videos in out/, a job's own uploaded assets
 * in jobs/<id>/assets/, and library/ assets. One route covers all three so
 * every page — gallery preview, resources dropzone thumbnail, editor
 * player, library grid — can just point an <video>/<img>/<audio> src here.
 *
 * URL shape: /api/media/<root>/<...rest>, root ∈ out | jobs | library.
 */

const ALLOWED_ROOTS = new Set(["out", "jobs", "library"]);

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

/** Serves a file with Range support — required for <video>/<audio> seeking
 *  to work at all in Chrome. Without a 206 response to a Range request, the
 *  element treats the resource as unseekable and setting `currentTime` is
 *  silently ignored. */
function serveFile(filePath: string, contentType: string, rangeHeader: string | null): NextResponse {
  const size = fs.statSync(filePath).size;
  const data = fs.readFileSync(filePath);
  const range = parseRange(rangeHeader, size);
  if (range) {
    const chunk = data.subarray(range.start, range.end + 1);
    return new NextResponse(new Uint8Array(chunk), {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Content-Length": String(chunk.length),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  }
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    },
  });
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

  const rootDir = path.join(repoRoot, root);
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
  if (path.extname(resolved).toLowerCase() === ".mov") {
    const previewPath = `${resolved}.preview.mp4`;
    if (!fs.existsSync(previewPath)) {
      try {
        execFileSync(
          "ffmpeg",
          [
            "-y",
            "-v",
            "error",
            "-i",
            resolved,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            previewPath,
          ],
          { stdio: ["ignore", "ignore", "inherit"] },
        );
      } catch {
        // Transcode failed (corrupt file, missing ffmpeg, etc.) — fall
        // through and serve the original as-is rather than 500.
      }
    }
    if (fs.existsSync(previewPath)) {
      return serveFile(previewPath, "video/mp4", req.headers.get("range"));
    }
  }

  const contentType = CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
  return serveFile(resolved, contentType, req.headers.get("range"));
}

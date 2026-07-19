import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { repoRoot } from "../../../../pipeline/paths";

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

export async function GET(
  _req: NextRequest,
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

  const contentType = CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
  const data = fs.readFileSync(resolved);
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    },
  });
}

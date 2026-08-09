import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { jobExists } from "../../../../lib/jobs";
import { findThumbnailSource } from "../../../../lib/projects";
import { artifactsDir } from "@backend/pipeline/paths";
import { ensurePreviewThumbnail } from "@backend/pipeline/previewMedia";

/**
 * One poster frame per project tile on the /projects dashboard. Prefers
 * the rendered export, falls back to the first bound video/image (see
 * findThumbnailSource) — a draft with nothing filmed yet has no source at
 * all, so callers should treat a 404 here as "show a placeholder tile",
 * not an error.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const source = findThumbnailSource(jobId);
  if (!source) {
    return NextResponse.json({ error: "no thumbnail available" }, { status: 404 });
  }

  const cachePath = path.join(artifactsDir(jobId), "thumbnail.jpg");
  try {
    await ensurePreviewThumbnail(source.absPath, cachePath, source.kind === "video" ? 0.3 : 0);
  } catch (err) {
    console.error(`thumbnail: ffmpeg failed for ${source.absPath}`, err);
    return NextResponse.json({ error: "thumbnail generation failed" }, { status: 500 });
  }

  const data = fs.readFileSync(cachePath);
  return new NextResponse(new Uint8Array(data), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" },
  });
}

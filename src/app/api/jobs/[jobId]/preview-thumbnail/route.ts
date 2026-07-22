import { NextRequest, NextResponse } from "next/server";
import { jobExists } from "../../../../lib/jobs";
import { previewCachePath, previewCacheUrl, resolveJobAssetAbsPath } from "../../../../lib/previewAssets";
import { ensurePreviewThumbnail } from "@backend/pipeline/previewMedia";

/**
 * A single poster frame for a job's clip, used by the media panel instead
 * of mounting a live <video> per clip (16+ of those competing with the
 * Player for decoders was a chunk of the editor's playback jank).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const src = req.nextUrl.searchParams.get("src");
  const atSec = Number(req.nextUrl.searchParams.get("t") ?? "0");
  if (!jobExists(jobId) || !src) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const sourceAbsPath = resolveJobAssetAbsPath(jobId, src);
  if (!sourceAbsPath) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const cacheAbsPath = previewCachePath(sourceAbsPath, ".thumb.jpg");
  try {
    await ensurePreviewThumbnail(sourceAbsPath, cacheAbsPath, Number.isFinite(atSec) ? atSec : 0);
  } catch (err) {
    console.error(`preview-thumbnail: ffmpeg failed for ${sourceAbsPath}`, err);
    return NextResponse.json({ error: "thumbnail generation failed" }, { status: 500 });
  }

  return NextResponse.redirect(new URL(previewCacheUrl(cacheAbsPath), req.url));
}

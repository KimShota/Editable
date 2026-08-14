import { NextRequest, NextResponse } from "next/server";
import { jobExists } from "../../../../lib/jobs";
import { previewCachePath, previewCacheUrl, resolveJobAssetAbsPath, thumbnailAtSecToken } from "../../../../lib/previewAssets";
import { ensurePreviewThumbnail } from "@backend/pipeline/previewMedia";

/**
 * A single poster frame for a job's clip, used by the media panel instead
 * of mounting a live <video> per clip (16+ of those competing with the
 * Player for decoders was a chunk of the editor's playback jank).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const src = req.nextUrl.searchParams.get("src");
  const rawAtSec = Number(req.nextUrl.searchParams.get("t") ?? "0");
  const atSec = Number.isFinite(rawAtSec) ? rawAtSec : 0;
  if (!jobExists(jobId) || !src) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const sourceAbsPath = resolveJobAssetAbsPath(jobId, src);
  if (!sourceAbsPath) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Suffix folds in the requested timestamp, not just ".thumb.jpg" — see
  // thumbnailAtSecToken's own doc comment: two timeline clips sharing one
  // source file at different trim points need their OWN cache entries,
  // otherwise whichever asks first permanently wins the cache slot for
  // every other timestamp too.
  const cacheAbsPath = previewCachePath(sourceAbsPath, `.at${thumbnailAtSecToken(atSec)}.thumb.jpg`);
  try {
    await ensurePreviewThumbnail(sourceAbsPath, cacheAbsPath, atSec);
  } catch (err) {
    console.error(`preview-thumbnail: ffmpeg failed for ${sourceAbsPath}`, err);
    return NextResponse.json({ error: "thumbnail generation failed" }, { status: 500 });
  }

  // Relative Location — see preview-proxy/route.ts for why an absolute
  // redirect built from req.url breaks behind a reverse proxy. Same
  // bounded (not immutable) Cache-Control too, and for the same reason:
  // this URL is keyed on `src`/`t`, not on content, so it can't safely be
  // cached forever — see that route's own comment.
  return new NextResponse(null, {
    status: 307,
    headers: { Location: previewCacheUrl(cacheAbsPath), "Cache-Control": "public, max-age=60" },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { jobExists } from "../../../../lib/jobs";
import { previewCachePath, previewCacheUrl, resolveJobAssetAbsPath } from "../../../../lib/previewAssets";
import { ensurePreviewProxy } from "@backend/pipeline/previewMedia";

/**
 * Editor-only video proxy: transcodes a job's source clip down to a small,
 * cheap-to-decode stand-in the first time it's requested (cached next to
 * the original after), and redirects to it. Never used by the export path
 * — render.ts feeds Remotion the original sources directly.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const src = req.nextUrl.searchParams.get("src");
  if (!jobExists(jobId) || !src) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const sourceAbsPath = resolveJobAssetAbsPath(jobId, src);
  if (!sourceAbsPath) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const cacheAbsPath = previewCachePath(sourceAbsPath, ".mp4");
  try {
    await ensurePreviewProxy(sourceAbsPath, cacheAbsPath);
  } catch (err) {
    console.error(`preview-proxy: ffmpeg failed for ${sourceAbsPath}`, err);
    return NextResponse.json({ error: "proxy generation failed" }, { status: 500 });
  }

  return NextResponse.redirect(new URL(previewCacheUrl(cacheAbsPath), req.url));
}

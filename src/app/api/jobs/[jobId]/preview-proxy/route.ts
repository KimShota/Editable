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

  // A RELATIVE Location, not NextResponse.redirect(new URL(..., req.url)).
  // Behind a reverse proxy, req.url carries the address the app was reached
  // on internally (localhost:3100), not the one the browser used, so an
  // absolute redirect built from it points the browser at a host that only
  // exists on the server — every preview 404s with ERR_CONNECTION_REFUSED.
  // previewCacheUrl is already root-relative, and RFC 7231 lets Location be
  // relative, so the browser resolves it against the page's own origin. That
  // works behind any proxy and in local dev without reading forwarded
  // headers. NextResponse.redirect() itself can't be used here: it requires
  // an absolute URL.
  //
  // A 307 is NOT cached by a browser at all by default (per RFC 7231
  // §6.4.7, unlike 301/308) — every one of these was a full round trip
  // even for a `src` this exact process already resolved moments ago. The
  // Player's <Video>/<OffthreadVideo> requests this SAME URL independently
  // of Editor.tsx's own prewarm fetch (see its warmedPreviewSources
  // effect), so on a typical load this was being paid TWICE per clip.
  // Bounded, not immutable, on purpose: unlike the destination file this
  // redirect points to (content-addressed — see previewCachePath), this
  // URL is keyed on `src`, which does NOT change when the user replaces
  // that asset's content. A long cache here would keep pointing a
  // browser at the pre-replacement proxy indefinitely; 60s bounds that
  // staleness to something short enough to not matter while still
  // collapsing same-session duplicate/rapid-reload requests, which is
  // where the actual repeated cost was coming from.
  return new NextResponse(null, {
    status: 307,
    headers: { Location: previewCacheUrl(cacheAbsPath), "Cache-Control": "public, max-age=60" },
  });
}

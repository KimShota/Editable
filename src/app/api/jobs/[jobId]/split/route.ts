import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { jobExists, jobDir, readJobManifest } from "../../../../lib/jobs";
import { intake } from "@backend/pipeline/intake";
import { loadFormat } from "@backend/pipeline/loader";
import { readSplit, runSplit, adjustSplit } from "@backend/pipeline/orchestrate";
import { readTakePrep } from "@backend/pipeline/prepareTake";
import type { FilledFormat, Format, JobManifest } from "@backend/pipeline/types";

/** Per-original-clip conversion between COMBINED-file time (what
 *  split.blocks' srcInSec/srcOutSec are always in) and that clip's own
 *  NATIVE playback time — clipSec = combinedSec - offsetSec + srcInSec.
 *  The split UI needs this to seek/scrub each clip's own <video> against
 *  spans that are otherwise only meaningful against the (never directly
 *  shown, in multi-clip mode) combined file. Always returns at least one
 *  entry when a take is bound at all: a single-clip take's "window" is
 *  just the identity mapping (offsetSec 0, srcInSec 0) against the bound
 *  file itself, so the client can use the SAME conversion logic regardless
 *  of whether the take turned out to be one clip or several. */
const buildClipWindows = (
  jobId: string,
  takeFile: string | undefined,
): { path: string; offsetSec: number; srcInSec: number }[] => {
  if (!takeFile) return [];
  const prep = readTakePrep(jobId);
  if (prep && prep.combinedPath === takeFile) {
    return prep.clips
      .filter((c) => c.ordering !== "excluded")
      .map((c) => ({ path: c.input.path, offsetSec: c.offsetSec, srcInSec: c.srcInSec }));
  }
  return [{ path: takeFile, offsetSec: 0, srcInSec: 0 }];
};

/**
 * Single-take split (resources wizard Step 3, "Split your take into
 * lines" — see schemas.ts's speakingTakeSlot doc comment). Only meaningful
 * for a format with speakingTakeSlot set.
 *
 * GET: current split, or null before it's ever been run.
 * POST: (re-)runs auto-split from scratch — "Re-align lines".
 * PATCH: persists one manually dragged span.
 *
 * Both GET and POST also resolve `takeFile` — the job-relative path to the
 * media the split is actually against. For an ordinary single-clip take
 * this is just the bound file; for a multi-clip take (see prepareTake.ts)
 * it's the derived combined MP4, which the client has no other way to
 * learn (the raw manifest binding is a LIST of the original clips, not the
 * stitched result).
 */

/** Cheap (no intake/whisper/ffmpeg) resolution straight from the manifest —
 *  used by GET, which shouldn't pay intake's cost just to render a page. A
 *  multi-clip binding resolves to takePrep's own combined file ONLY when
 *  that file still exists on disk (a fresh multi-clip binding with no
 *  takePrep yet returns undefined — POST will produce one). */
const takeFileFromManifest = (jobId: string, format: Format, manifest: JobManifest): string | undefined => {
  const slot = format.speakingTakeSlot;
  const binding = slot ? manifest.bindings[slot.name] : undefined;
  if (!binding) return undefined;
  if ("file" in binding) return binding.file;
  if ("files" in binding) {
    const prep = readTakePrep(jobId);
    if (prep && fs.existsSync(path.join(jobDir(jobId), prep.combinedPath))) return prep.combinedPath;
  }
  return undefined;
};

/** Authoritative resolution from a freshly intaken FilledFormat — used by
 *  POST, which already pays intake's cost and so always sees the CURRENT
 *  resolved take (single clip or freshly-prepared combined file alike). */
const takeFileFromFilled = (format: Format, filled: FilledFormat): string | undefined => {
  const slot = format.speakingTakeSlot;
  const bound = slot ? filled.bindings[slot.name] : undefined;
  return bound?.type === "file" ? bound.path : undefined;
};

export async function GET(_req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  const manifest = readJobManifest(jobId);
  const format = loadFormat(manifest.format);
  const takeFile = takeFileFromManifest(jobId, format, manifest);
  return NextResponse.json({ split: readSplit(jobId), takeFile, clipWindows: buildClipWindows(jobId, takeFile) });
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  try {
    const filled = intake(jobDir(jobId));
    const format = loadFormat(filled.formatId);
    const split = runSplit(format, filled, jobId);
    const takeFile = takeFileFromFilled(format, filled);
    return NextResponse.json({ split, takeFile, clipWindows: buildClipWindows(jobId, takeFile) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => null);
  const { blockId, clipPath, srcInSec, srcOutSec } = body ?? {};
  if (
    typeof blockId !== "string" ||
    (clipPath !== undefined && typeof clipPath !== "string") ||
    typeof srcInSec !== "number" ||
    typeof srcOutSec !== "number" ||
    srcOutSec <= srcInSec
  ) {
    return NextResponse.json(
      { error: "expected { blockId: string, clipPath?: string, srcInSec: number, srcOutSec: number } with srcOutSec > srcInSec" },
      { status: 400 },
    );
  }
  try {
    const split = adjustSplit(jobId, blockId, clipPath, srcInSec, srcOutSec);
    return NextResponse.json({ split });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

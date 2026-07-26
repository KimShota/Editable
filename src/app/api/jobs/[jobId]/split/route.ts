import { NextRequest, NextResponse } from "next/server";
import { jobExists, jobDir } from "../../../../lib/jobs";
import { intake } from "@backend/pipeline/intake";
import { loadFormat } from "@backend/pipeline/loader";
import { readSplit, runSplit, adjustSplit } from "@backend/pipeline/orchestrate";

/**
 * Single-take split (resources wizard Step 3, "Split your take into
 * lines" — see schemas.ts's speakingTakeSlot doc comment). Only meaningful
 * for a format with speakingTakeSlot set.
 *
 * GET: current split, or null before it's ever been run.
 * POST: (re-)runs auto-split from scratch — "Re-align lines".
 * PATCH: persists one manually dragged span.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  return NextResponse.json({ split: readSplit(jobId) });
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
    return NextResponse.json({ split });
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
  const { blockId, srcInSec, srcOutSec } = body ?? {};
  if (
    typeof blockId !== "string" ||
    typeof srcInSec !== "number" ||
    typeof srcOutSec !== "number" ||
    srcOutSec <= srcInSec
  ) {
    return NextResponse.json({ error: "expected { blockId: string, srcInSec: number, srcOutSec: number } with srcOutSec > srcInSec" }, { status: 400 });
  }
  try {
    const split = adjustSplit(jobId, blockId, srcInSec, srcOutSec);
    return NextResponse.json({ split });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

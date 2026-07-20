import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { jobExists, jobDir } from "../../../../../lib/jobs";
import { readOrMigrateEdl } from "@backend/pipeline/orchestrate";
import { applyOp } from "@backend/pipeline/timelineOps";
import { artifactsDir } from "@backend/pipeline/paths";
import { stageAssets } from "@backend/pipeline/render";

/**
 * The primary edit path once a job has an EDL: applies one timeline op
 * (move/trim/reorder/split/delete/setProp) directly to edl.json and
 * persists the result. Unlike /override, this never calls back into
 * assemble() — the document IS the edit, the same way dragging a clip in
 * an NLE never re-runs whatever generated the initial cut.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }

  const op = await req.json().catch(() => null);
  if (!op) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  try {
    const edl = readOrMigrateEdl(jobDir(jobId), jobId);
    const next = applyOp(edl, op);
    stageAssets(next);
    fs.writeFileSync(path.join(artifactsDir(jobId), "edl.json"), JSON.stringify(next, null, 2));
    return NextResponse.json({ edl: next });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

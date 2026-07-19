import { NextRequest, NextResponse } from "next/server";
import { jobExists, readJobManifest, writeJobManifest, jobDir } from "../../../../lib/jobs";
import { reassembleJob } from "../../../../../pipeline/orchestrate";
import { ComponentRef } from "../../../../../pipeline/types";

type OverridePatch = {
  events?: Record<string, { timeSec?: number; component?: ComponentRef }>;
  transitions?: Record<string, ComponentRef>;
};

/**
 * Merges a partial override patch into job.json (nudge an event's time,
 * swap a component/transition) and re-runs assembly only — no
 * transcription or LLM calls, so this is fast enough for a live "editor"
 * slider without re-touching anything the user didn't ask to change.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  const patch = (await req.json().catch(() => null)) as OverridePatch | null;
  if (!patch) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const manifest = readJobManifest(jobId);
  const overrides = manifest.overrides ?? { events: {}, transitions: {} };
  manifest.overrides = {
    events: { ...overrides.events, ...patch.events },
    transitions: { ...overrides.transitions, ...patch.transitions },
  };
  writeJobManifest(jobId, manifest);

  try {
    const edl = reassembleJob(jobDir(jobId), jobId);
    return NextResponse.json({ edl });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

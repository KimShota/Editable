import { NextRequest, NextResponse } from "next/server";
import { jobExists, jobDir } from "../../../../lib/jobs";
import { buildJob } from "@backend/pipeline/orchestrate";
import { ResolverChoice } from "@backend/pipeline/resolvers";

/** Runs intake through assemble (transcription + role resolution included). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => ({}));
  const resolver: ResolverChoice = body?.resolver ?? "auto";

  try {
    const edl = await buildJob(jobDir(jobId), jobId, resolver);
    return NextResponse.json({ edl });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

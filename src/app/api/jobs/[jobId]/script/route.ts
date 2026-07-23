import { NextRequest, NextResponse } from "next/server";
import { loadFormat } from "@backend/pipeline/loader";
import { ContentChoice } from "@backend/content/provider";
import { generateScript } from "@backend/content/script";
import { jobExists, jobScriptExists, readJobManifest, readJobScript, writeJobScript } from "../../../../lib/jobs";

/** Generates (and persists) spoken-line/short-text suggestions for a job's
 *  format, given a topic — the "what do I actually say" gap between a
 *  format's generic filming instructions and one creator's real content. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => null);
  const topic = body?.topic;
  if (typeof topic !== "string" || topic.trim().length === 0) {
    return NextResponse.json({ error: "a topic is required" }, { status: 400 });
  }
  const choice: ContentChoice = body?.resolver ?? "auto";

  try {
    const format = loadFormat(readJobManifest(jobId).format);
    const script = await generateScript(format, topic.trim(), choice);
    writeJobScript(jobId, script);
    return NextResponse.json({ script });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  return NextResponse.json({ script: jobScriptExists(jobId) ? readJobScript(jobId) : null });
}

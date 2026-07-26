import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { loadFormat } from "@backend/pipeline/loader";
import { ContentChoice } from "@backend/content/provider";
import { generateScript } from "@backend/content/script";
import { ScriptSuggestionSchema } from "@backend/content/schemas";
import {
  jobExists,
  jobScriptExists,
  readJobManifest,
  readJobScript,
  writeJobScript,
} from "../../../../lib/jobs";

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

/** Persists a hand-edited suggestion set as-is — e.g. the wizard's numbered
 *  line editor (Step 1) lets someone rewrite a suggested line in place;
 *  this is the save path for that, distinct from POST's generate-from-topic. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => null);
  const parsed = ScriptSuggestionSchema.safeParse(body?.script);
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  writeJobScript(jobId, parsed.data);
  return NextResponse.json({ script: parsed.data });
}

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  return NextResponse.json({ script: jobScriptExists(jobId) ? readJobScript(jobId) : null });
}

import { NextResponse } from "next/server";
import { jobExists, readJobManifest, getJobStatus } from "../../../lib/jobs";
import { loadFormat } from "@backend/pipeline/loader";

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  const manifest = readJobManifest(jobId);
  const format = loadFormat(manifest.format);
  const status = getJobStatus(jobId);
  return NextResponse.json({ jobId, manifest, format, status });
}

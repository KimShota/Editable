import { NextRequest, NextResponse } from "next/server";
import { createJob, listJobs } from "../../lib/jobs";
import { formatExists } from "../../lib/formats";

export async function GET() {
  return NextResponse.json({ jobs: listJobs() });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const formatId = body?.formatId;
  if (typeof formatId !== "string" || !formatExists(formatId)) {
    return NextResponse.json({ error: `unknown format "${formatId}"` }, { status: 400 });
  }
  const jobId = createJob(formatId);
  return NextResponse.json({ jobId }, { status: 201 });
}

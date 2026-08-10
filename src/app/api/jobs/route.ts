import { NextRequest, NextResponse } from "next/server";
import { createJob, listJobsForUser } from "../../lib/jobs";
import { formatExists } from "../../lib/formats";
import { getRequestUser } from "../../lib/auth";

export async function GET() {
  const user = await getRequestUser();
  if (!user) return NextResponse.json({ error: "log in required" }, { status: 401 });
  return NextResponse.json({ jobs: await listJobsForUser(user) });
}

export async function POST(req: NextRequest) {
  const user = await getRequestUser();
  if (!user) return NextResponse.json({ error: "log in required" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const formatId = body?.formatId;
  if (typeof formatId !== "string" || !formatExists(formatId)) {
    return NextResponse.json({ error: `unknown format "${formatId}"` }, { status: 400 });
  }
  const jobId = await createJob(formatId, user.id);
  return NextResponse.json({ jobId }, { status: 201 });
}

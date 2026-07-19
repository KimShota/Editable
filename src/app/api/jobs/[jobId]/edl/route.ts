import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { jobExists } from "../../../../lib/jobs";
import { artifactsDir } from "@backend/pipeline/paths";

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  const edlPath = path.join(artifactsDir(jobId), "edl.json");
  if (!fs.existsSync(edlPath)) {
    return NextResponse.json({ error: "not built yet" }, { status: 404 });
  }
  return NextResponse.json({ edl: JSON.parse(fs.readFileSync(edlPath, "utf8")) });
}

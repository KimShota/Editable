import { NextRequest, NextResponse } from "next/server";
import { jobExists } from "../../../../lib/jobs";
import { deleteProjectPermanently, renameProject, restoreProject, trashProject } from "../../../../lib/projects";

/** Renames a project (writes project.json's display name). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  renameProject(jobId, name);
  return NextResponse.json({ ok: true });
}

/** Restores a project out of the trash. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  restoreProject(jobId);
  return NextResponse.json({ ok: true });
}

/** Trashes a project (soft, reversible); ?permanent=1 deletes it for good. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  if (req.nextUrl.searchParams.get("permanent") === "1") {
    deleteProjectPermanently(jobId);
  } else {
    trashProject(jobId);
  }
  return NextResponse.json({ ok: true });
}

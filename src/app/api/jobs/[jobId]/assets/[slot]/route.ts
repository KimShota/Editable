import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { jobExists, readJobManifest, writeJobManifest, jobDir } from "../../../../../lib/jobs";

/** Clears a slot's binding (and deletes the uploaded file, if any). */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ jobId: string; slot: string }> },
) {
  const { jobId, slot } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  const manifest = readJobManifest(jobId);
  const binding = manifest.bindings[slot];
  if (binding && "file" in binding) {
    const absPath = path.join(jobDir(jobId), binding.file);
    if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
  }
  delete manifest.bindings[slot];
  writeJobManifest(jobId, manifest);
  return NextResponse.json({ ok: true });
}

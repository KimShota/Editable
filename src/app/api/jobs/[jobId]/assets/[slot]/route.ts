import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { jobExists, readJobManifest, writeJobManifest, jobDir } from "../../../../../lib/jobs";

const unlinkIfExists = (jobId: string, relPath: string) => {
  const absPath = path.join(jobDir(jobId), relPath);
  if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
};

/**
 * Clears a slot's binding (and deletes the uploaded file(s), if any). For a
 * multi-take slot, pass ?index=N to remove just that one take instead of
 * every take bound to the slot.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string; slot: string }> },
) {
  const { jobId, slot } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  const manifest = readJobManifest(jobId);
  const binding = manifest.bindings[slot];
  const indexParam = req.nextUrl.searchParams.get("index");

  if (binding && "files" in binding && indexParam !== null) {
    const index = Number(indexParam);
    const removed = binding.files[index];
    if (removed === undefined) {
      return NextResponse.json({ error: "take index out of range" }, { status: 400 });
    }
    unlinkIfExists(jobId, removed);
    const remaining = binding.files.filter((_, i) => i !== index);
    if (remaining.length > 0) {
      manifest.bindings[slot] = { files: remaining };
    } else {
      delete manifest.bindings[slot];
    }
    writeJobManifest(jobId, manifest);
    return NextResponse.json({ ok: true, binding: manifest.bindings[slot] });
  }

  if (binding && "file" in binding) {
    unlinkIfExists(jobId, binding.file);
  } else if (binding && "files" in binding) {
    for (const f of binding.files) unlinkIfExists(jobId, f);
  }
  delete manifest.bindings[slot];
  writeJobManifest(jobId, manifest);
  return NextResponse.json({ ok: true });
}

import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { jobExists, readJobManifest, writeJobManifest, jobDir } from "../../../../lib/jobs";
import { isLibraryCategory, libraryDir } from "../../../../lib/library";
import { loadFormat } from "../../../../../pipeline/loader";
import { allSlots } from "../../../../../pipeline/intake";

/** Binds one slot: a file upload, or a text string for text-typed slots. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }

  const manifest = readJobManifest(jobId);
  const format = loadFormat(manifest.format);
  const formData = await req.formData();
  const slotName = formData.get("slot");
  if (typeof slotName !== "string") {
    return NextResponse.json({ error: "missing slot" }, { status: 400 });
  }
  const slot = allSlots(format).find((s) => s.name === slotName);
  if (!slot) {
    return NextResponse.json({ error: `format has no slot "${slotName}"` }, { status: 400 });
  }

  if (slot.mediaType === "text") {
    const text = formData.get("text");
    if (typeof text !== "string") {
      return NextResponse.json({ error: "missing text" }, { status: 400 });
    }
    manifest.bindings[slotName] = { text };
    writeJobManifest(jobId, manifest);
    return NextResponse.json({ slot: slotName, binding: manifest.bindings[slotName] });
  }

  // Dragged in from the Library: copy by reference instead of re-uploading bytes.
  const libraryRef = formData.get("libraryRef");
  if (typeof libraryRef === "string") {
    const { category, filename } = JSON.parse(libraryRef);
    if (!isLibraryCategory(category)) {
      return NextResponse.json({ error: `invalid library category "${category}"` }, { status: 400 });
    }
    const srcPath = path.join(libraryDir(category), filename);
    if (!fs.existsSync(srcPath)) {
      return NextResponse.json({ error: "library asset not found" }, { status: 404 });
    }
    const ext = path.extname(filename);
    const relPath = path.posix.join("assets", `${slotName}${ext}`);
    const absPath = path.join(jobDir(jobId), relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.copyFileSync(srcPath, absPath);
    manifest.bindings[slotName] = { file: relPath };
    writeJobManifest(jobId, manifest);
    return NextResponse.json({ slot: slotName, binding: manifest.bindings[slotName] });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing file or libraryRef" }, { status: 400 });
  }
  const ext = path.extname(file.name) || "";
  const relPath = path.posix.join("assets", `${slotName}${ext}`);
  const absPath = path.join(jobDir(jobId), "assets", `${slotName}${ext}`);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, Buffer.from(await file.arrayBuffer()));

  manifest.bindings[slotName] = { file: relPath };
  writeJobManifest(jobId, manifest);
  return NextResponse.json({ slot: slotName, binding: manifest.bindings[slotName] });
}

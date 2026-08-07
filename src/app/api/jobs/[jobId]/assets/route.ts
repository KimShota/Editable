import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { jobExists, readJobManifest, writeJobManifest, jobDir, invalidateTakeArtifacts } from "../../../../lib/jobs";
import { isLibraryCategory, libraryDir } from "../../../../lib/library";
import { loadFormat } from "@backend/pipeline/loader";
import { allSlots } from "@backend/pipeline/intake";
import { formatAssetsDir } from "@backend/pipeline/paths";

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
  // Multiple files are only meaningful for a voice block's main clip (takes
  // to auto-order/concatenate — see intake.ts), the identity slot (several
  // reference photos of the same person), or the speaking-take slot itself
  // (several clips stitched into one continuous take — see prepareTake.ts)
  // — those are the slots where a 2nd/3rd upload APPENDS instead of
  // replacing the binding.
  const isMultiSlot =
    format.blocks.some((b) => b.kind === "voice" && b.videoSlot === slotName) ||
    format.identitySlot?.name === slotName ||
    format.speakingTakeSlot?.name === slotName;
  const isTakeSlot = format.speakingTakeSlot?.name === slotName;

  if (slot.mediaType === "text") {
    const text = formData.get("text");
    if (typeof text !== "string") {
      return NextResponse.json({ error: "missing text" }, { status: 400 });
    }
    manifest.bindings[slotName] = { text };
    writeJobManifest(jobId, manifest);
    return NextResponse.json({ slot: slotName, binding: manifest.bindings[slotName] });
  }

  const existing = manifest.bindings[slotName];
  // A slot that used to bind exactly one file (the take slot, before its
  // second clip ever showed up) upgrades in place — the new upload APPENDS
  // to it rather than discarding it, same as any other multi-slot.
  const existingFiles = !isMultiSlot
    ? []
    : existing && "files" in existing
      ? existing.files
      : existing && "file" in existing
        ? [existing.file]
        : [];
  let takeCount = existingFiles.length;
  const nextRelPath = (ext: string) => path.posix.join("assets", `${slotName}-${++takeCount}${ext}`);

  // Picking the format's own checked-in fallback for this slot (see
  // SlotSchema's defaultAsset doc comment) — same copy-by-reference
  // treatment as a Library drag below, just sourced from
  // formats/assets/<formatId>/ instead of library/<category>/, so the user
  // can explicitly choose "use the template clip" over filming their own.
  const formatDefault = formData.get("formatDefault");
  if (typeof formatDefault === "string") {
    if (!slot.defaultAsset) {
      return NextResponse.json({ error: `slot "${slotName}" has no default asset` }, { status: 400 });
    }
    const srcPath = path.join(formatAssetsDir(format.id), slot.defaultAsset.file);
    if (!fs.existsSync(srcPath)) {
      return NextResponse.json({ error: "default asset not found" }, { status: 404 });
    }
    const ext = path.extname(slot.defaultAsset.file);
    const relPath = isMultiSlot ? nextRelPath(ext) : path.posix.join("assets", `${slotName}${ext}`);
    const absPath = path.join(jobDir(jobId), relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.copyFileSync(srcPath, absPath);
    manifest.bindings[slotName] = isMultiSlot
      ? { files: [...existingFiles, relPath] }
      : { file: relPath };
    writeJobManifest(jobId, manifest);
    if (isTakeSlot) invalidateTakeArtifacts(jobId);
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
    const relPath = isMultiSlot ? nextRelPath(ext) : path.posix.join("assets", `${slotName}${ext}`);
    const absPath = path.join(jobDir(jobId), relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.copyFileSync(srcPath, absPath);
    manifest.bindings[slotName] = isMultiSlot
      ? { files: [...existingFiles, relPath] }
      : { file: relPath };
    writeJobManifest(jobId, manifest);
    if (isTakeSlot) invalidateTakeArtifacts(jobId);
    return NextResponse.json({ slot: slotName, binding: manifest.bindings[slotName] });
  }

  // A multi-take slot may receive several files in one drop (formData
  // supports repeated keys); a single-file slot only ever reads the first.
  const files = formData.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "missing file or libraryRef" }, { status: 400 });
  }

  if (!isMultiSlot) {
    const file = files[0];
    const ext = path.extname(file.name) || "";
    const relPath = path.posix.join("assets", `${slotName}${ext}`);
    const absPath = path.join(jobDir(jobId), relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, Buffer.from(await file.arrayBuffer()));
    manifest.bindings[slotName] = { file: relPath };
    writeJobManifest(jobId, manifest);
    return NextResponse.json({ slot: slotName, binding: manifest.bindings[slotName] });
  }

  const newRelPaths: string[] = [];
  for (const file of files) {
    const ext = path.extname(file.name) || "";
    const relPath = nextRelPath(ext);
    const absPath = path.join(jobDir(jobId), relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, Buffer.from(await file.arrayBuffer()));
    newRelPaths.push(relPath);
  }
  manifest.bindings[slotName] = { files: [...existingFiles, ...newRelPaths] };
  writeJobManifest(jobId, manifest);
  return NextResponse.json({ slot: slotName, binding: manifest.bindings[slotName] });
}

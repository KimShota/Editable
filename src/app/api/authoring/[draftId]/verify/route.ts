import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { authoringDir, repoRoot } from "@backend/pipeline/paths";
import { draftExists, draftFormatExists, readAuthoringStatus, writeAuthoringStatus } from "../../../../lib/authoring";

/**
 * Re-runs just the "verify" stage for an existing draft — the review UI's
 * "Run verify" button. Same "spawn a real child process + poll" shape as
 * api/authoring/route.ts (a whisper pass plus a full Remotion render is far
 * too slow to hold open as one request), scoped down with `--only verify`
 * so it doesn't re-ingest/re-analyze/re-synthesize a draft that's already
 * been reviewed.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  if (!draftExists(draftId) || !draftFormatExists(draftId)) {
    return NextResponse.json({ error: "draft not found" }, { status: 404 });
  }

  const current = readAuthoringStatus(draftId);
  if (current.status === "running") {
    return NextResponse.json({ draftId, ...current }, { status: 202 });
  }

  const startedAt = new Date().toISOString();
  writeAuthoringStatus(draftId, { status: "running", stage: "verify", startedAt });

  const child = spawn("npm", ["run", "author", "--", "--draft", draftId, "--only", "verify"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrTail = "";
  let stdoutTail = "";
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });
  child.stdout.on("data", (chunk) => {
    stdoutTail = (stdoutTail + chunk.toString()).slice(-4000);
  });
  child.on("close", (code) => {
    const finishedAt = new Date().toISOString();
    // verify() never throws (see its own doc comment) — a real failure
    // (missing ffmpeg, a corrupt reference clip) degrades to a mostly-empty
    // verify.json rather than a non-zero exit, so checking the exit code
    // alone isn't enough to confirm a fresh result actually landed.
    const verifyJsonPath = path.join(authoringDir(draftId), "verify.json");
    const wroteFreshResult = fs.existsSync(verifyJsonPath) && fs.statSync(verifyJsonPath).mtime >= new Date(startedAt);
    if (code === 0 && wroteFreshResult) {
      writeAuthoringStatus(draftId, { status: "done", startedAt, finishedAt });
    } else {
      writeAuthoringStatus(draftId, {
        status: "error",
        startedAt,
        finishedAt,
        error: stderrTail || stdoutTail || `verify process exited with code ${code}`,
      });
    }
  });

  return NextResponse.json({ draftId, status: "running", stage: "verify" }, { status: 202 });
}

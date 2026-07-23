import { spawn } from "node:child_process";
import { NextRequest, NextResponse } from "next/server";
import { newDraftId } from "@backend/authoring/ingest";
import { repoRoot } from "@backend/pipeline/paths";
import { draftFormatExists, writeAuthoringStatus, AuthoringStage } from "../../lib/authoring";

/**
 * Starts the format-authoring pipeline (ingest → analyze → synthesize) for
 * one reel URL. Spawned as a real child process — same "background job +
 * poll" shape as api/jobs/[jobId]/render/route.ts — because the full run
 * (a yt-dlp download, whisper transcription, ffmpeg shot detection, and a
 * multimodal LLM call with repair rounds) can run well past what's
 * comfortable to hold open as a single request.
 */

const STAGE_LINE = /^ {2}✔ (ingest|analyze|synthesize)/;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const url = body?.url;
  if (typeof url !== "string" || url.trim().length === 0) {
    return NextResponse.json({ error: "a reel url is required" }, { status: 400 });
  }

  const draftId = newDraftId();
  const startedAt = new Date().toISOString();
  writeAuthoringStatus(draftId, { status: "running", stage: "ingest", startedAt });

  const child = spawn("npm", ["run", "author", "--", "--url", url.trim(), "--draft", draftId], {
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
    for (const line of chunk.toString().split("\n")) {
      const match = line.match(STAGE_LINE);
      if (match) {
        writeAuthoringStatus(draftId, { status: "running", stage: match[1] as AuthoringStage, startedAt });
      }
    }
  });
  child.on("close", (code) => {
    const finishedAt = new Date().toISOString();
    if (code === 0 && draftFormatExists(draftId)) {
      writeAuthoringStatus(draftId, { status: "done", startedAt, finishedAt });
    } else {
      writeAuthoringStatus(draftId, {
        status: "error",
        startedAt,
        finishedAt,
        error: stderrTail || stdoutTail || `authoring process exited with code ${code}`,
      });
    }
  });

  return NextResponse.json({ draftId, status: "running", stage: "ingest" }, { status: 202 });
}

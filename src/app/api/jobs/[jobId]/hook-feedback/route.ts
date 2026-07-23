import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { loadFormat } from "@backend/pipeline/loader";
import { requireWhisperModel, transcribeFile } from "@backend/pipeline/whisper";
import { ContentChoice } from "@backend/content/provider";
import { getHookFeedback } from "@backend/content/virality";
import {
  jobDir,
  jobExists,
  jobHookFeedbackExists,
  jobScriptExists,
  readJobHookFeedback,
  readJobManifest,
  readJobScript,
  writeJobHookFeedback,
} from "../../../../lib/jobs";

/**
 * Critiques a job's hook — the first "voice" block in its format — before
 * or after it's filmed. Deliberately does NOT go through the full
 * intake()/FilledFormat path: that validates every required slot and would
 * throw on a job that's still mid-filming, when "just tell me if my hook
 * is good" is exactly the moment this is useful.
 */

/** Resolves the hook clip's real spoken text by transcribing just that one
 *  binding (one or more takes) — reuses transcribeFile directly rather
 *  than the whole transcribe.ts block/take-ordering machinery, since a
 *  quick feedback preview doesn't need real playback ordering. */
const transcribeHookBinding = (jobId: string, files: string[]): string => {
  requireWhisperModel();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-hook-feedback-"));
  try {
    const words = files.flatMap((relPath) => transcribeFile(path.join(jobDir(jobId), relPath), workDir));
    return words.map((w) => w.text).join(" ");
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => ({}));
  const choice: ContentChoice = body?.resolver ?? "auto";

  try {
    const manifest = readJobManifest(jobId);
    const format = loadFormat(manifest.format);
    const hookBlock = format.blocks.find((b) => b.kind === "voice");
    if (!hookBlock) {
      return NextResponse.json({ error: "this format has no voice block to critique" }, { status: 400 });
    }

    const binding = manifest.bindings[hookBlock.videoSlot];
    let hookText: string;
    let source: "filmed" | "suggested";

    if (binding && "file" in binding) {
      hookText = transcribeHookBinding(jobId, [binding.file]);
      source = "filmed";
    } else if (binding && "files" in binding) {
      hookText = transcribeHookBinding(jobId, binding.files);
      source = "filmed";
    } else if (jobScriptExists(jobId)) {
      const suggestion = readJobScript(jobId).suggestions.find(
        (s) => s.blockId === hookBlock.id && s.slotName === hookBlock.videoSlot,
      );
      if (!suggestion) {
        return NextResponse.json(
          { error: "hook isn't filmed yet and no script suggestion covers it — generate a script first" },
          { status: 400 },
        );
      }
      hookText = suggestion.text;
      source = "suggested";
    } else {
      return NextResponse.json(
        { error: "hook isn't filmed yet — film it or generate a script suggestion first" },
        { status: 400 },
      );
    }

    if (hookText.trim().length === 0) {
      return NextResponse.json({ error: "no speech detected in the hook clip" }, { status: 400 });
    }

    const feedback = await getHookFeedback(format, hookBlock.title, hookText, choice);
    const result = { ...feedback, createdAt: new Date().toISOString(), hookText, source };
    writeJobHookFeedback(jobId, result);
    return NextResponse.json({ feedback: result });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  return NextResponse.json({ feedback: jobHookFeedbackExists(jobId) ? readJobHookFeedback(jobId) : null });
}

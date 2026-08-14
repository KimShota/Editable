import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { NextRequest, NextResponse } from "next/server";
import { jobExists, jobDir } from "../../../../lib/jobs";
import { acquirePipelineSlot } from "../../../../lib/pipelineQueue";
import { getRequestUser } from "../../../../lib/auth";
import { checkAndRecordQuota } from "../../../../lib/quota";
import { repoRoot, artifactsDir } from "@backend/pipeline/paths";
import { Edl } from "@backend/pipeline/types";

/**
 * Runs intake through assemble (transcription + role resolution included).
 *
 * A job with generation-marked slots pays for paid Gemini/Higgsfield calls
 * plus whisper/ffmpeg work per block — minutes, not seconds. Running that
 * in-process inside this request (as this route used to, via orchestrate.ts's
 * buildJob) means the browser's fetch eventually gives up waiting and the
 * connection drops as a raw "Failed to fetch", losing all progress with no
 * error the user can act on. Same "background job + poll" shape as
 * render/route.ts: spawn the pipeline as its own process, report progress
 * through a status file, return immediately.
 */

type BuildStatus =
  | { status: "idle" }
  | { status: "building"; startedAt: string; stage: string }
  | { status: "done"; startedAt: string; finishedAt: string; edl: Edl }
  | { status: "error"; startedAt: string; finishedAt: string; error: string };

const statusPath = (jobId: string) => path.join(artifactsDir(jobId), "build-status.json");
const readStatus = (jobId: string): BuildStatus | null =>
  fs.existsSync(statusPath(jobId))
    ? JSON.parse(fs.readFileSync(statusPath(jobId), "utf8"))
    : null;
const writeStatus = (jobId: string, status: BuildStatus): void => {
  fs.mkdirSync(artifactsDir(jobId), { recursive: true });
  fs.writeFileSync(statusPath(jobId), JSON.stringify(status, null, 2));
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  const existing = readStatus(jobId);
  if (existing?.status === "building") {
    return NextResponse.json(existing, { status: 202 });
  }

  // Middleware already 401s an unauthenticated request before it reaches
  // here (see middleware.ts) — getRequestUser() returning null on a job
  // route would mean that guarantee broke, not a real anonymous caller.
  const user = await getRequestUser();
  if (!user) {
    return NextResponse.json({ error: "log in required" }, { status: 401 });
  }
  const quota = await checkAndRecordQuota(user, jobId, "build");
  if (!quota.ok) {
    return NextResponse.json({ error: quota.error }, { status: quota.status });
  }

  const body = await req.json().catch(() => ({}));
  const resolver = typeof body?.resolver === "string" ? body.resolver : "auto";
  const generator = typeof body?.generator === "string" ? body.generator : "auto";

  const startedAt = new Date().toISOString();
  writeStatus(jobId, { status: "building", startedAt, stage: "queued" });

  // Don't await the slot here — the route must still return 202
  // immediately (see this file's own docstring on why building can't block
  // the request). The status file stays at "queued" until a slot actually
  // frees up and the child process starts.
  acquirePipelineSlot().then((release) => {
    const child = spawn(
      "npm",
      [
        "run",
        "pipeline",
        "--",
        "--job",
        jobDir(jobId),
        "--stop-after",
        "assemble",
        "--resolver",
        resolver,
        "--generator",
        generator,
      ],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderrTail = "";
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });
    child.stdout.on("data", (chunk) => {
      // run.ts logs "  ✔ <artifact>   → ..." as each stage's artifact is
      // written (see run.ts's own `write` helper) — the last one seen is the
      // furthest-along stage, good enough for a "Building… (matte)" label
      // without needing a structured progress channel.
      const matches = chunk.toString().match(/✔ (\S+)/g);
      if (matches) {
        const stage = matches[matches.length - 1].replace("✔ ", "");
        writeStatus(jobId, { status: "building", startedAt, stage });
      }
    });
    child.on("close", (code) => {
      release();
      const finishedAt = new Date().toISOString();
      const edlPath = path.join(artifactsDir(jobId), "edl.json");
      if (code === 0 && fs.existsSync(edlPath)) {
        const edl = JSON.parse(fs.readFileSync(edlPath, "utf8"));
        writeStatus(jobId, { status: "done", startedAt, finishedAt, edl });
      } else {
        const error = stderrTail || `build exited with code ${code}`;
        console.error(`build failed for job "${jobId}":\n${error}`);
        writeStatus(jobId, { status: "error", startedAt, finishedAt, error });
      }
    });
  });

  return NextResponse.json({ status: "building", startedAt, stage: "queued" }, { status: 202 });
}

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  const status = readStatus(jobId) ?? { status: "idle" as const };
  // A pipeline failure's stderr tail can carry absolute server paths, stack
  // traces, or a raw Anthropic/Gemini SDK error — fine for triage, not for
  // a friend's browser. Full detail is already in the journal (see the
  // console.error above); only an admin gets it here too.
  if (status.status === "error") {
    const user = await getRequestUser();
    if (!user?.isAdmin) {
      return NextResponse.json({ ...status, error: "the build failed — ask an admin to check the server logs" });
    }
  }
  return NextResponse.json(status);
}

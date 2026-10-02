import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { jobExists } from "../../../../lib/jobs";
import { getRequestUser } from "../../../../lib/auth";
import { repoRoot, artifactsDir } from "@backend/pipeline/paths";

/**
 * The editor's per-clip Regenerate (AI videos only): a new take of the one
 * shot a timeline clip was cut from, swapped into this job's edl.json by
 * `npm run produce -- regen-clip` (see production/cli.ts), which keeps every
 * other edit. It costs real money (a video model call), so:
 *
 *   POST { clipId }                 → { estimateUsd }   asks the price, spends nothing
 *   POST { clipId, confirm: true }  → 202               starts it in the background
 *   GET                             → { clips }         status per clip, polled by the editor
 *
 * Same "child process + status file the client polls" shape as the render
 * route: a generation takes minutes and must not block the server. Admin
 * only while the pilot is founder-run.
 */

type ClipStatus =
  | { status: "running"; startedAt: string }
  | { status: "done"; startedAt: string; finishedAt: string }
  | { status: "error"; startedAt: string; finishedAt: string; error: string };

const statusPath = (jobId: string) => path.join(artifactsDir(jobId), "regen-status.json");
const readStatuses = (jobId: string): Record<string, ClipStatus> =>
  fs.existsSync(statusPath(jobId)) ? JSON.parse(fs.readFileSync(statusPath(jobId), "utf8")) : {};
const writeStatus = (jobId: string, clipId: string, status: ClipStatus): void => {
  // Re-read so two clips regenerating at once don't overwrite each other.
  const all = readStatuses(jobId);
  all[clipId] = status;
  fs.writeFileSync(statusPath(jobId), JSON.stringify(all, null, 2));
};

const produceArgs = (jobId: string, clipId: string, extra: string[] = []) => ["run", "-s", "produce", "--", "regen-clip", "--job", jobId, "--clip", clipId, ...extra];

/** The CLI's own message for a refusal (not an AI shot, etc.), not a stack. */
const lastLine = (text: string) => text.trim().split("\n").filter(Boolean).pop() ?? "regeneration failed";

const isAiVideo = (jobId: string) => fs.existsSync(path.join(repoRoot, "jobs", jobId, "ai-video.json"));

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) return NextResponse.json({ error: "job not found" }, { status: 404 });
  return NextResponse.json({ clips: readStatuses(jobId) });
}

export async function POST(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId) || !isAiVideo(jobId)) {
    return NextResponse.json({ error: "only AI videos have clips to regenerate" }, { status: 404 });
  }
  const user = await getRequestUser();
  if (!user?.isAdmin) {
    return NextResponse.json({ error: "regenerating a clip spends AI credits; admins only for now" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { clipId?: unknown; confirm?: unknown };
  const clipId = typeof body.clipId === "string" && /^[A-Za-z0-9._-]+$/.test(body.clipId) ? body.clipId : null;
  if (!clipId) return NextResponse.json({ error: "clipId required" }, { status: 400 });

  if (body.confirm !== true) {
    // Price check only. The estimate endpoint call is quick and free.
    const result = await new Promise<{ ok: boolean; out: string }>((resolve) => {
      execFile("npm", produceArgs(jobId, clipId, ["--dry"]), { cwd: repoRoot, timeout: 60_000 }, (err, stdout, stderr) =>
        resolve({ ok: !err, out: err ? stderr || String(err) : stdout }),
      );
    });
    const usd = result.out.match(/estimate_usd ([\d.]+)/)?.[1];
    if (!result.ok || !usd) return NextResponse.json({ error: lastLine(result.out) }, { status: 400 });
    return NextResponse.json({ estimateUsd: Number(usd) });
  }

  const existing = readStatuses(jobId)[clipId];
  if (existing?.status === "running") return NextResponse.json(existing, { status: 202 });

  const startedAt = new Date().toISOString();
  writeStatus(jobId, clipId, { status: "running", startedAt });
  const child = spawn("npm", produceArgs(jobId, clipId), { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  let stderrTail = "";
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });
  child.stdout.on("data", () => {
    // Drained so the child never blocks on a full pipe; progress isn't parsed.
  });
  child.on("close", (code) => {
    const finishedAt = new Date().toISOString();
    if (code === 0) writeStatus(jobId, clipId, { status: "done", startedAt, finishedAt });
    else {
      console.error(`regenerate-clip failed for ${jobId}/${clipId}:\n${stderrTail}`);
      writeStatus(jobId, clipId, { status: "error", startedAt, finishedAt, error: lastLine(stderrTail) });
    }
  });
  return NextResponse.json({ status: "running", startedAt }, { status: 202 });
}

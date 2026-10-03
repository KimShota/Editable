import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { NextRequest, NextResponse } from "next/server";
import { jobExists } from "../../../../lib/jobs";
import { getRequestUser } from "../../../../lib/auth";
import { repoRoot } from "@backend/pipeline/paths";
import { readShotChat } from "@backend/production/shotChats";
import { takesForClip } from "@backend/production/takes";

/**
 * An AI shot's change chat (AI videos only): the user says what they want
 * different, Claude answers with a plan for a new take and its price
 * (`npm run produce -- shot-chat`, see production/shotChange.ts). Nothing is
 * generated here; the plan's Generate goes through regenerate-clip with its
 * planId.
 *
 *   GET  ?clipId=s8                → { shotId, messages }
 *   POST { clipId, message }       → { shotId, messages }   one turn, ~10-30 s
 *
 * Like regenerate-clip, the work runs in the produce CLI (Claude, ffmpeg
 * frame grabs, the price check), and posting is admin only: each turn is a
 * paid model call.
 */

const validId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._-]+$/.test(v);
const isAiVideo = (jobId: string) => fs.existsSync(path.join(repoRoot, "jobs", jobId, "ai-video.json"));
const MAX_MESSAGE = 1000;

/** The CLI's own message for a refusal or failure, not a stack. */
const lastLine = (text: string) => text.trim().split("\n").filter(Boolean).pop() ?? "the shot chat failed";

export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const clipId = req.nextUrl.searchParams.get("clipId");
  if (!jobExists(jobId) || !isAiVideo(jobId) || !validId(clipId)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const { shotId } = takesForClip(jobId, clipId);
    return NextResponse.json({ shotId, messages: readShotChat(jobId, shotId) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 404 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId) || !isAiVideo(jobId)) return NextResponse.json({ error: "only AI videos have shots to change" }, { status: 404 });
  const user = await getRequestUser();
  if (!user?.isAdmin) return NextResponse.json({ error: "the shot chat spends AI credits; admins only for now" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { clipId?: unknown; message?: unknown };
  if (!validId(body.clipId)) return NextResponse.json({ error: "clipId required" }, { status: 400 });
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "say what you want to change" }, { status: 400 });
  if (message.length > MAX_MESSAGE) return NextResponse.json({ error: `keep it under ${MAX_MESSAGE} characters` }, { status: 400 });

  // An argument array, never a shell: the message can't escape into a command.
  const args = ["run", "-s", "produce", "--", "shot-chat", "--job", jobId, "--clip", body.clipId, "--message", message];
  const result = await new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
    execFile("npm", args, { cwd: repoRoot, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr: stderr || String(err ?? "") }));
  });
  const line = result.stdout.split("\n").find((l) => l.startsWith("RESULT "));
  if (!result.ok || !line) {
    console.error(`shot-chat failed for ${jobId}/${body.clipId}:\n${result.stderr.slice(-4000)}`);
    return NextResponse.json({ error: lastLine(result.stderr) }, { status: 500 });
  }
  const { shotId } = JSON.parse(line.slice("RESULT ".length)) as { shotId: string };
  return NextResponse.json({ shotId, messages: readShotChat(jobId, shotId) });
}

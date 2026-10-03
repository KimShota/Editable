import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { jobExists } from "../../../../lib/jobs";
import { getRequestUser } from "../../../../lib/auth";
import { enqueueBrandTask, queue } from "../../../../lib/tasks";
import { repoRoot } from "@backend/pipeline/paths";
import { productionOps } from "@backend/jobs/productionFactory";
import { getStorage } from "@backend/storage";

/**
 * The editor's per-clip Regenerate (AI videos only): a new take of the one
 * shot a timeline clip was cut from, kept beside the others. It costs real
 * money (a video model call), so:
 *
 *   POST { clipId }                 → { estimateUsd }   asks the price, spends nothing
 *   POST { clipId, confirm: true }  → 202               queues it (job clip.regenerate)
 *   …and either with planId         the change a shot-chat plan describes (see shot-chat)
 *   GET                             → { clips }         status per clip, polled by the editor
 *
 * It runs on the work queue like every other slow job (it used to spawn the
 * CLI itself and keep a status file), so it survives a restart and shows in
 * the same place. GET's shape is unchanged: the editor reads `clips`. Admin
 * only while the pilot is founder-run.
 */

type ClipStatus =
  | { status: "running"; startedAt: string }
  | { status: "done"; startedAt: string; finishedAt: string }
  | { status: "error"; startedAt: string; finishedAt: string; error: string };

/** Which brand video a job is, from the file `produce render` writes. */
const brandVideo = (jobId: string): { slug: string; cardId: string } | null => {
  const file = path.join(repoRoot, "jobs", jobId, "ai-video.json");
  if (!fs.existsSync(file)) return null;
  const meta = JSON.parse(fs.readFileSync(file, "utf8")) as { brand?: string; card?: string; source?: string };
  const cardId = meta.card ?? meta.source;
  return meta.brand && cardId ? { slug: meta.brand, cardId } : null;
};

/** Newest task per clip, as the status the editor shows. */
const statuses = async (slug: string, cardId: string, isAdmin: boolean): Promise<Record<string, ClipStatus>> => {
  const tasks = await queue.listTasks({ slug, cardId, kinds: ["clip.regenerate"], includeRecentMinutes: 60 }); // newest first
  const out: Record<string, ClipStatus> = {};
  for (const t of tasks) {
    const clipId = (t.payload as { clipId?: string }).clipId;
    if (!clipId || out[clipId]) continue;
    if (t.status === "queued" || t.status === "running") out[clipId] = { status: "running", startedAt: t.createdAt };
    else if (t.status === "done") out[clipId] = { status: "done", startedAt: t.createdAt, finishedAt: t.finishedAt ?? t.createdAt };
    else out[clipId] = { status: "error", startedAt: t.createdAt, finishedAt: t.finishedAt ?? t.createdAt, error: isAdmin ? (t.error ?? "regeneration failed") : "Regeneration failed." };
  }
  return out;
};

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) return NextResponse.json({ error: "job not found" }, { status: 404 });
  const user = await getRequestUser();
  const video = brandVideo(jobId);
  if (!user || !video) return NextResponse.json({ clips: {} });
  return NextResponse.json({ clips: await statuses(video.slug, video.cardId, user.isAdmin) });
}

export async function POST(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const video = jobExists(jobId) ? brandVideo(jobId) : null;
  if (!video) return NextResponse.json({ error: "only AI videos have clips to regenerate" }, { status: 404 });
  const user = await getRequestUser();
  if (!user?.isAdmin) {
    return NextResponse.json({ error: "regenerating a clip spends AI credits; admins only for now" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { clipId?: unknown; confirm?: unknown; planId?: unknown };
  const clipId = typeof body.clipId === "string" && /^[A-Za-z0-9._-]+$/.test(body.clipId) ? body.clipId : null;
  if (!clipId) return NextResponse.json({ error: "clipId required" }, { status: 400 });
  if (body.planId !== undefined && !(typeof body.planId === "string" && /^[A-Za-z0-9-]+$/.test(body.planId))) {
    return NextResponse.json({ error: "bad planId" }, { status: 400 });
  }
  const planId = typeof body.planId === "string" ? body.planId : undefined;

  if (body.confirm !== true) {
    // Price check only: quick, and free.
    try {
      const { usd } = await productionOps(getStorage()).regenEstimate(jobId, clipId, planId);
      return NextResponse.json({ estimateUsd: usd });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "could not price this" }, { status: 400 });
    }
  }

  const live = (await statuses(video.slug, video.cardId, true))[clipId];
  if (live?.status === "running") return NextResponse.json(live, { status: 202 });
  // One attempt: a failed generation is looked at, not silently paid for again.
  await enqueueBrandTask("clip.regenerate", { slug: video.slug, cardId: video.cardId, clipId, planId }, { maxAttempts: 1, discriminator: clipId });
  return NextResponse.json({ status: "running", startedAt: new Date().toISOString() }, { status: 202 });
}

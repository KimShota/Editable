import { NextResponse } from "next/server";
import { z } from "zod";
import { sourceIdFromUrl } from "@backend/recreation/decompose";
import { parseViralUrl } from "@backend/recreation/viralUrl";
import { brandRoute, ConflictError, readJsonBody } from "../../../../lib/brandApi";
import { enqueueBrandTask, queue } from "../../../../lib/tasks";

/**
 * POST /api/brands/<slug>/sources { url } — "recreate this viral video":
 * downloads it and works out how it is built (job source.ingest). The link
 * must be an Instagram reel, a TikTok or a YouTube Short: the downloader
 * would otherwise fetch whatever address it is given.
 */

const Body = z.object({ url: z.string().min(1).max(500) });

/** Each link costs a download and a model call. */
const MAX_LIVE_INGESTS = 3;

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return brandRoute(slug, async () => {
    const { url: raw } = await readJsonBody(req, Body);
    const url = parseViralUrl(raw);
    const live = await queue.listTasks({ slug, kinds: ["source.ingest"] });
    if (live.length >= MAX_LIVE_INGESTS) throw new ConflictError("A few videos are still being added. Try again when one finishes.");
    const taskId = await enqueueBrandTask("source.ingest", { slug, url }, { discriminator: sourceIdFromUrl(url) });
    return NextResponse.json({ ok: true, taskId, sourceId: sourceIdFromUrl(url) });
  });
}

import { NextRequest, NextResponse } from "next/server";
import { jobExists } from "../../../../lib/jobs";
import { chooseTake, takesForClip } from "@backend/production/takes";

/**
 * Every take of the shot a timeline clip was cut from (AI videos), and
 * switching between them. Choosing a take is free and instant: the file
 * already exists, it only goes back on the timeline (see production/takes.ts).
 *
 *   GET  ?clipId=s8               → { shotId, regenerable, currentTakeId, takes }
 *   POST { clipId, takeId }       → { edl }
 */

const validId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._-]+$/.test(v);

export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const clipId = req.nextUrl.searchParams.get("clipId");
  if (!jobExists(jobId) || !validId(clipId)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const result = takesForClip(jobId, clipId);
    // Paths on disk stay on the server.
    const takes = result.takes.map((t) => ({ id: t.id, src: t.src, inSec: t.inSec, durationSec: t.durationSec, createdAt: t.createdAt, origin: t.origin }));
    return NextResponse.json({ ...result, takes });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 404 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) return NextResponse.json({ error: "job not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { clipId?: unknown; takeId?: unknown };
  if (!validId(body.clipId) || !validId(body.takeId)) return NextResponse.json({ error: "clipId and takeId required" }, { status: 400 });
  try {
    return NextResponse.json({ edl: chooseTake(jobId, body.clipId, body.takeId) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

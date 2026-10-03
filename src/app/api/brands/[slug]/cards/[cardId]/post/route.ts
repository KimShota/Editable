import { NextResponse } from "next/server";
import { z } from "zod";
import { isVideoVisible } from "@backend/plan/status";
import { brandRoute, readJsonBody } from "../../../../../../lib/brandApi";
import { brandRepo } from "../../../../../../lib/brandRepo";

/**
 * PUT /api/brands/<slug>/cards/<cardId>/post { caption, hashtags, platforms }:
 * what will be posted with the video. Posting itself is manual in this
 * phase (download, copy, mark as posted), so the platforms are a note.
 */

const Hashtag = z
  .string()
  .trim()
  .transform((h) => h.replace(/^#+/, ""))
  .pipe(z.string().min(1).max(50).regex(/^[^\s#]+$/, "A hashtag cannot contain spaces"));

const Body = z.object({
  caption: z.string().max(2200, "A caption can be at most 2,200 characters"),
  hashtags: z.array(Hashtag).max(30, "At most 30 hashtags"),
  platforms: z.array(z.enum(["tiktok", "instagram", "youtube"])).max(3),
});

export async function PUT(req: Request, { params }: { params: Promise<{ slug: string; cardId: string }> }) {
  const { slug, cardId } = await params;
  return brandRoute(slug, async ({ user }) => {
    const body = await readJsonBody(req, Body);
    const card = await brandRepo.getCard(slug, cardId);
    if (!card || !isVideoVisible(card.status, user.isAdmin)) return NextResponse.json({ error: "not found" }, { status: 404 });
    // Keep where it was posted: only the customer's wording changes here.
    const current = await brandRepo.getPostDetails(slug, cardId);
    const saved = await brandRepo.savePostDetails(slug, cardId, { ...current, caption: body.caption, hashtags: [...new Set(body.hashtags)], platforms: body.platforms });
    return NextResponse.json({ ok: true, post: saved });
  });
}

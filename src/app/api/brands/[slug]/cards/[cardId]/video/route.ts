import { NextResponse } from "next/server";
import { z } from "zod";
import { isVideoVisible } from "@backend/plan/status";
import { productionKeys } from "@backend/brand/keys";
import { isWebAddress, PostDetailsSchema } from "@backend/plan/schemas";
import { brandRoute, ConflictError, readJsonBody } from "../../../../../../lib/brandApi";
import { brandRepo } from "../../../../../../lib/brandRepo";

/**
 * POST /api/brands/<slug>/cards/<cardId>/video { action }: what a customer does
 * with a finished video. The status rules are backend/plan/status.ts's; this
 * adds only that the video must be one they may see (it has passed the
 * founder's review gate).
 *
 *   approve       needs_review → ready
 *   unapprove     ready → needs_review
 *   not_right     needs_review → internal_review, with why (the founder looks again)
 *   mark_posted   ready → posted, with the link(s) of where it went up
 */

const REASONS = ["character_off", "product_wrong", "weird_motion", "audio", "other"] as const;

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("unapprove") }),
  z.object({ action: z.literal("not_right"), reason: z.enum(REASONS), note: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal("mark_posted"), urls: z.array(z.string().trim().url("Paste the full link, starting with https://").refine(isWebAddress, "Paste the full link, starting with https://")).min(1, "Paste at least one link").max(3) }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ slug: string; cardId: string }> }) {
  const { slug, cardId } = await params;
  return brandRoute(slug, async ({ user }) => {
    const body = await readJsonBody(req, Body);
    const card = await brandRepo.getCard(slug, cardId);
    // A video behind the review gate does not exist as far as a customer knows.
    if (!card || !isVideoVisible(card.status, user.isAdmin)) return NextResponse.json({ error: "not found" }, { status: 404 });
    const actor = user.isAdmin ? "admin" : "customer";

    switch (body.action) {
      case "approve":
        await brandRepo.transitionCard(slug, cardId, "ready", actor);
        break;
      case "unapprove":
        await brandRepo.transitionCard(slug, cardId, "needs_review", actor);
        break;
      case "not_right":
        await brandRepo.transitionCard(slug, cardId, "internal_review", actor, { thumbsDown: { reason: body.reason, note: body.note, at: new Date().toISOString() } });
        break;
      case "mark_posted": {
        if (card.status !== "ready") throw new ConflictError("Approve the video before marking it as posted.");
        const details = await brandRepo.getPostDetails(slug, cardId);
        // Validate before changing the status, so a bad link cannot leave a video marked posted with nothing saved.
        const posted = PostDetailsSchema.parse({ ...details, postedUrls: body.urls, postedAt: new Date().toISOString() });
        await brandRepo.transitionCard(slug, cardId, "posted", actor);
        await brandRepo.savePostDetails(slug, cardId, posted);
        break;
      }
    }
    return NextResponse.json({ ok: true, video: productionKeys(slug, cardId).final });
  });
}

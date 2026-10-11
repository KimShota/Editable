import { NextResponse } from "next/server";
import { z } from "zod";
import { productionKeys } from "@backend/brand/keys";
import { isWebAddress, PostDetailsSchema } from "@backend/plan/schemas";
import { brandRoute, ConflictError, readJsonBody } from "../../../../../../lib/brandApi";
import { brandRepo } from "../../../../../../lib/brandRepo";

/**
 * POST /api/brands/<slug>/cards/<cardId>/video { action }: what a person does
 * with a finished video. The status rules are backend/plan/status.ts's.
 *
 *   mark_posted   ready → posted, with the link(s) of where it went up
 */

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("mark_posted"), urls: z.array(z.string().trim().url("Paste the full link, starting with https://").refine(isWebAddress, "Paste the full link, starting with https://")).min(1, "Paste at least one link").max(3) }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ slug: string; cardId: string }> }) {
  const { slug, cardId } = await params;
  return brandRoute(slug, async () => {
    const body = await readJsonBody(req, Body);
    const card = await brandRepo.getCard(slug, cardId);
    if (!card) return NextResponse.json({ error: "not found" }, { status: 404 });
    const actor = "user";

    switch (body.action) {
      case "mark_posted": {
        if (card.status !== "ready") throw new ConflictError("Only a video that is ready can be marked as posted.");
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

import { NextResponse } from "next/server";
import { canTransition } from "@backend/plan/status";
import { brandRoute, ConflictError } from "../../../../../../lib/brandApi";
import { brandRepo } from "../../../../../../lib/brandRepo";
import { enqueueBrandTask } from "../../../../../../lib/tasks";

/**
 * POST /api/brands/<slug>/cards/<cardId>/release: the user starts
 * making an approved card's video (job video.produce), which spends real
 * money. Also remakes a card that failed. One attempt only: a failed run is never
 * silently paid for again; the user chooses to make it again.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ slug: string; cardId: string }> }) {
  const { slug, cardId } = await params;
  return brandRoute(
    slug,
    async () => {
      const card = await brandRepo.getCard(slug, cardId);
      if (!card) return NextResponse.json({ error: "not found" }, { status: 404 });
      if (!canTransition(card.status, "queued", "user")) throw new ConflictError(`A ${card.status} video cannot be released.`);
      if (!(await brandRepo.getScript(slug, cardId))) throw new ConflictError("This video has no script yet.");

      await brandRepo.transitionCard(slug, cardId, "queued", "user");
      let taskId: number | null;
      try {
        taskId = await enqueueBrandTask("video.produce", { slug, cardId }, { maxAttempts: 1 });
      } catch (err) {
        // Not released after all: put it back where it was found.
        await brandRepo.transitionCard(slug, cardId, "approved", "user").catch(() => undefined);
        throw err;
      }
      return NextResponse.json({ ok: true, taskId });
    }
  );
}

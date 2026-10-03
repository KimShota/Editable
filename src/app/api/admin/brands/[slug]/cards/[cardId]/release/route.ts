import { NextResponse } from "next/server";
import { canTransition } from "@backend/plan/status";
import { brandRoute, ConflictError } from "../../../../../../../lib/brandApi";
import { brandRepo } from "../../../../../../../lib/brandRepo";
import { enqueueBrandTask } from "../../../../../../../lib/tasks";

/**
 * POST /api/admin/brands/<slug>/cards/<cardId>/release: the founder releases
 * an approved card to production (job video.produce), which spends real
 * money. Also re-releases a card that failed, or one the founder sent back
 * from internal review. One attempt only: a failed run is looked at by a
 * person, never silently paid for again.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ slug: string; cardId: string }> }) {
  const { slug, cardId } = await params;
  return brandRoute(
    slug,
    async () => {
      const card = await brandRepo.getCard(slug, cardId);
      if (!card) return NextResponse.json({ error: "not found" }, { status: 404 });
      if (!canTransition(card.status, "queued", "admin")) throw new ConflictError(`A ${card.status} video cannot be released.`);
      if (!(await brandRepo.getScript(slug, cardId))) throw new ConflictError("This video has no script yet.");

      await brandRepo.transitionCard(slug, cardId, "queued", "admin");
      let taskId: number | null;
      try {
        taskId = await enqueueBrandTask("video.produce", { slug, cardId }, { maxAttempts: 1 });
      } catch (err) {
        // Not released after all: put it back where it was found.
        await brandRepo.transitionCard(slug, cardId, "approved", "admin").catch(() => undefined);
        throw err;
      }
      return NextResponse.json({ ok: true, taskId });
    },
    { adminOnly: true },
  );
}

import { NextResponse } from "next/server";
import { canTransition } from "@backend/plan/status";
import { brandRoute } from "../../../../../lib/brandApi";
import { brandRepo } from "../../../../../lib/brandRepo";
import { queue } from "../../../../../lib/tasks";

/**
 * POST /api/brands/<slug>/cards/approve-all — approves every draft that has a
 * script and is not being written right now. Cards it skips are listed, so
 * the screen can say why "all" was not all.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return brandRoute(slug, async ({ user }) => {
    const actor = user.isAdmin ? "admin" : "customer";
    const plan = await brandRepo.getPlan(slug);
    if (!plan) return NextResponse.json({ error: "this brand has no plan yet" }, { status: 409 });
    const busy = new Set((await queue.listTasks({ slug, kinds: ["card.adapt", "card.storyboard"] })).map((t) => (t.payload as { cardId?: string }).cardId));

    const approved: string[] = [];
    const skipped: { cardId: string; reason: string }[] = [];
    for (const card of plan.cards) {
      if (!canTransition(card.status, "approved", actor)) continue; // not a draft: nothing to do
      if (busy.has(card.id)) skipped.push({ cardId: card.id, reason: "still being written" });
      else if (!(await brandRepo.getScript(slug, card.id))) skipped.push({ cardId: card.id, reason: "no script yet" });
      else {
        await brandRepo.transitionCard(slug, card.id, "approved", actor);
        approved.push(card.id);
      }
    }
    return NextResponse.json({ ok: true, approved, skipped });
  });
}

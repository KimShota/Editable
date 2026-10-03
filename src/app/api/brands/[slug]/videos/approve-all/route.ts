import { NextResponse } from "next/server";
import { z } from "zod";
import { brandRoute, readJsonBody } from "../../../../../lib/brandApi";
import { brandRepo } from "../../../../../lib/brandRepo";

/**
 * POST /api/brands/<slug>/videos/approve-all { includeFlagged? }: approves
 * every video waiting for the customer's review (needs_review → ready).
 * A video QC flagged as low confidence is held back unless the customer
 * says to include those too: a warning is a reason to look first. What was
 * skipped, and why, is returned so the screen can say so.
 */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return brandRoute(slug, async ({ user }) => {
    const { includeFlagged } = await readJsonBody(req, z.object({ includeFlagged: z.boolean().optional() }));
    const plan = await brandRepo.getPlan(slug);
    if (!plan) return NextResponse.json({ error: "this brand has no plan yet" }, { status: 409 });
    const actor = user.isAdmin ? "admin" : "customer";

    const approved: string[] = [];
    const skipped: { cardId: string; reason: string }[] = [];
    for (const card of plan.cards) {
      if (card.status !== "needs_review") continue;
      if (card.lowConfidence && !includeFlagged) {
        skipped.push({ cardId: card.id, reason: "flagged" });
        continue;
      }
      await brandRepo.transitionCard(slug, card.id, "ready", actor);
      approved.push(card.id);
    }
    return NextResponse.json({ ok: true, approved, skipped });
  });
}

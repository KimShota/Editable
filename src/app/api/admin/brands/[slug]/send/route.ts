import { NextResponse } from "next/server";
import { z } from "zod";
import { canTransition } from "@backend/plan/status";
import { brandRoute, readJsonBody } from "../../../../../lib/brandApi";
import { brandRepo } from "../../../../../lib/brandRepo";
import { publicOrigin } from "../../../../../lib/publicOrigin";
import { sendVideosReadyEmail } from "../../../../../lib/email";

/**
 * POST /api/admin/brands/<slug>/send { cardIds? }: the review gate. Moves
 * finished videos from internal review to the customer's "needs review" and
 * sends ONE email for the batch to the brand's workspace members. Without
 * cardIds it sends every video waiting at the gate.
 */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return brandRoute(
    slug,
    async ({ brand }) => {
      const { cardIds } = await readJsonBody(req, z.object({ cardIds: z.array(z.string()).max(50).optional() }));
      const plan = await brandRepo.getPlan(slug);
      if (!plan) return NextResponse.json({ error: "this brand has no plan yet" }, { status: 409 });

      const wanted = new Set(cardIds ?? plan.cards.filter((c) => c.status === "internal_review").map((c) => c.id));
      const sent: string[] = [];
      for (const card of plan.cards) {
        if (!wanted.has(card.id) || !canTransition(card.status, "needs_review", "admin")) continue;
        await brandRepo.transitionCard(slug, card.id, "needs_review", "admin");
        sent.push(card.id);
      }

      // One email for the batch. A failed email must not undo the release:
      // the videos are visible either way, so report it and carry on.
      let emailed = 0;
      let emailError: string | null = null;
      if (sent.length > 0) {
        const origin = publicOrigin(req);
        for (const member of await brandRepo.listMembers(slug)) {
          try {
            await sendVideosReadyEmail(member.email, brand.name, sent.length, `${origin}/calendar`);
            emailed++;
          } catch (err) {
            emailError = err instanceof Error ? err.message : String(err);
          }
        }
      }
      return NextResponse.json({ ok: true, sent, emailed, emailError });
    },
    { adminOnly: true },
  );
}

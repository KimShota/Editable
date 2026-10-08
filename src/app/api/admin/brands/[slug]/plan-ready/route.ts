import { NextResponse } from "next/server";
import { brandRoute, ConflictError } from "../../../../../lib/brandApi";
import { brandRepo } from "../../../../../lib/brandRepo";
import { publicOrigin } from "../../../../../lib/publicOrigin";
import { sendPlanReadyEmail } from "../../../../../lib/email";

/** POST /api/admin/brands/<slug>/plan-ready: tells the brand's members their
 *  plan is ready to review. Sent by the founder's button, once they have read
 *  the plan themselves; it needs a plan with cards. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return brandRoute(
    slug,
    async ({ brand }) => {
      const plan = await brandRepo.getPlan(slug);
      if (!plan || plan.cards.length === 0) throw new ConflictError("There is no plan to tell anyone about yet.");
      const link = `${publicOrigin(req)}/plan`;
      let sent = 0;
      let emailError: string | null = null;
      for (const m of await brandRepo.listMembers(slug)) {
        try {
          await sendPlanReadyEmail(m.email, brand.name, link);
          sent++;
        } catch (err) {
          emailError = err instanceof Error ? err.message : String(err);
        }
      }
      return NextResponse.json({ ok: true, sent, emailError });
    },
    { adminOnly: true },
  );
}

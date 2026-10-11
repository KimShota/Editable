import { NextResponse } from "next/server";
import { z } from "zod";
import { brandRoute, readJsonBody } from "../../../../lib/brandApi";
import { enqueueBrandTask } from "../../../../lib/tasks";

/** POST /api/brands/<slug>/plan { days? } — fills the free days of the
 *  brand's plan from its viral sources (job plan.build). */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return brandRoute(
    slug,
    async () => {
      const { days } = await readJsonBody(req, z.object({ days: z.number().int().min(1).max(14).optional() }));
      const taskId = await enqueueBrandTask("plan.build", { slug, days });
      return NextResponse.json({ ok: true, taskId });
    }
  );
}

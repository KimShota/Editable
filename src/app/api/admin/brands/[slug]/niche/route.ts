import { NextResponse } from "next/server";
import { brandRoute } from "../../../../../lib/brandApi";
import { enqueueBrandTask } from "../../../../../lib/tasks";

/** POST /api/admin/brands/<slug>/niche: asks the model for the brand's
 *  content angles (job niche.propose). It spends a few cents, so it is the
 *  founder's to start. */
export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return brandRoute(
    slug,
    async () => NextResponse.json({ ok: true, taskId: await enqueueBrandTask("niche.propose", { slug }, { maxAttempts: 1 }) }),
    { adminOnly: true },
  );
}

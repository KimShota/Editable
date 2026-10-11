import { NextResponse } from "next/server";
import { brandRoute } from "../../../../../lib/brandApi";
import { enqueueBrandTask } from "../../../../../lib/tasks";

/** POST /api/brands/<slug>/niche/propose: asks the model for the brand's
 *  content angles (job niche.propose). It spends a few cents. */
export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return brandRoute(
    slug,
    async () => NextResponse.json({ ok: true, taskId: await enqueueBrandTask("niche.propose", { slug }, { maxAttempts: 1 }) })
  );
}

import { NextResponse } from "next/server";
import { brandRoute } from "../../../../../../../lib/brandApi";
import { brandRepo } from "../../../../../../../lib/brandRepo";
import { enqueueBrandTask } from "../../../../../../../lib/tasks";

/** POST /api/admin/brands/<slug>/cards/<cardId>/estimate: what producing the
 *  card would cost (job video.estimate). Free of clip costs, but it voices the
 *  script, which is cheap and reused by the real run. */
export async function POST(_req: Request, { params }: { params: Promise<{ slug: string; cardId: string }> }) {
  const { slug, cardId } = await params;
  return brandRoute(
    slug,
    async () => {
      if (!(await brandRepo.getCard(slug, cardId))) return NextResponse.json({ error: "not found" }, { status: 404 });
      const taskId = await enqueueBrandTask("video.estimate", { slug, cardId }, { maxAttempts: 1 });
      return NextResponse.json({ ok: true, taskId });
    },
    { adminOnly: true },
  );
}

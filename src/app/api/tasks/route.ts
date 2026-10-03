import { NextRequest, NextResponse } from "next/server";
import { isBrandSlug } from "@backend/brand/keys";
import { getRequestUser } from "../../lib/auth";
import { BrandAccessError, brandRepo } from "../../lib/brandRepo";
import { queue } from "../../lib/tasks";
import { toPublicTask } from "./taskView";

/** GET ?slug=&kind=&cardId=&recent= — a brand's live tasks (and, with
 *  `recent` minutes, ones that just finished): how a page finds its running
 *  work again after a reload. */
export async function GET(req: NextRequest) {
  const user = await getRequestUser();
  if (!user) return NextResponse.json({ error: "log in required" }, { status: 401 });

  const q = req.nextUrl.searchParams;
  const slug = q.get("slug") ?? "";
  if (!isBrandSlug(slug)) return NextResponse.json({ error: "slug required" }, { status: 400 });
  try {
    await brandRepo.assertAccess(user, slug);
  } catch (err) {
    if (err instanceof BrandAccessError) return NextResponse.json({ error: "not found" }, { status: 404 });
    throw err;
  }

  const recent = Math.min(Math.max(Number(q.get("recent") ?? 0) || 0, 0), 60);
  const tasks = await queue.listTasks({
    slug,
    kinds: q.getAll("kind").length ? q.getAll("kind") : undefined,
    cardId: q.get("cardId") ?? undefined,
    includeRecentMinutes: recent,
  });
  return NextResponse.json({ tasks: tasks.map((t) => toPublicTask(t, user.isAdmin)) });
}

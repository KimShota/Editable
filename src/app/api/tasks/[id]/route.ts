import { NextRequest, NextResponse } from "next/server";
import { TaskPayloadSchema } from "@backend/jobs/payload";
import { getRequestUser } from "../../../lib/auth";
import { BrandAccessError, brandRepo } from "../../../lib/brandRepo";
import { queue } from "../../../lib/tasks";
import { toPublicTask } from "../taskView";

/** GET — one task's state, for <TaskProgress>. Visible to anyone who may
 *  open the brand it belongs to. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getRequestUser();
  if (!user) return NextResponse.json({ error: "log in required" }, { status: 401 });

  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "not found" }, { status: 404 });

  const task = await queue.getTask(id);
  const payload = task ? TaskPayloadSchema.safeParse(task.payload) : null;
  // A task with no brand in its payload (an analysis job) is not the app's to show.
  if (!task || !payload?.success) return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    await brandRepo.assertAccess(user, payload.data.slug);
  } catch (err) {
    if (err instanceof BrandAccessError) return NextResponse.json({ error: "not found" }, { status: 404 });
    throw err;
  }
  return NextResponse.json(toPublicTask(task, user.isAdmin));
}

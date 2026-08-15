import { NextRequest, NextResponse } from "next/server";
import { jobExists } from "../../../lib/jobs";
import { deleteProjectPermanently, restoreProject, trashProject } from "../../../lib/projects";

const ACTIONS = {
  trash: trashProject,
  restore: restoreProject,
  delete: deleteProjectPermanently,
} as const;

/** Bulk variant of the per-project trash/restore/delete actions in
 *  /api/jobs/[jobId]/project — same operations, applied to a list of ids
 *  for the Projects page's multi-select toolbar. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const ids = Array.isArray(body?.ids) ? body.ids.filter((id: unknown): id is string => typeof id === "string") : [];
  const action = body?.action;
  if (ids.length === 0 || !(action in ACTIONS)) {
    return NextResponse.json({ error: "ids and a valid action are required" }, { status: 400 });
  }
  const apply = ACTIONS[action as keyof typeof ACTIONS];
  for (const id of ids) {
    if (jobExists(id)) apply(id);
  }
  return NextResponse.json({ ok: true });
}

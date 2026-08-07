import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { authoringDir, repoRoot } from "@backend/pipeline/paths";
import { draftExists, draftFormatExists, readAuthoringStatus, readDraft, readVerifyResult } from "../../../lib/authoring";

/** Polled by the review UI while authoring runs; once done, also carries
 *  the draft itself so the client doesn't need a second round-trip.
 *  verifyMedia gives the review UI's side-by-side comparison its two
 *  playable URLs — existence-checked here (rather than assumed from
 *  verify.overallScore being set) since a verify run only ever writes
 *  verify.json AFTER the render succeeds, but the render itself can be
 *  cleaned up independently of the JSON summary. */
export async function GET(_req: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  if (!draftExists(draftId)) {
    return NextResponse.json({ error: "draft not found" }, { status: 404 });
  }
  const status = readAuthoringStatus(draftId);
  const draft = draftFormatExists(draftId) ? readDraft(draftId) : undefined;
  const verify = readVerifyResult(draftId);

  const sourcePath = path.join(authoringDir(draftId), "source.mp4");
  const renderPath = path.join(repoRoot, "out", `verify-${draftId}.mp4`);
  const verifyMedia = {
    sourceUrl: fs.existsSync(sourcePath) ? `/api/media/authoring/${draftId}/source.mp4` : null,
    renderUrl: fs.existsSync(renderPath) ? `/api/media/out/verify-${draftId}.mp4` : null,
  };

  return NextResponse.json({ ...status, draft, verify, verifyMedia });
}

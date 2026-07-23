import { NextResponse } from "next/server";
import { draftExists, draftFormatExists, readAuthoringStatus, readDraft } from "../../../lib/authoring";

/** Polled by the review UI while authoring runs; once done, also carries
 *  the draft itself so the client doesn't need a second round-trip. */
export async function GET(_req: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  if (!draftExists(draftId)) {
    return NextResponse.json({ error: "draft not found" }, { status: 404 });
  }
  const status = readAuthoringStatus(draftId);
  const draft = draftFormatExists(draftId) ? readDraft(draftId) : undefined;
  return NextResponse.json({ ...status, draft });
}

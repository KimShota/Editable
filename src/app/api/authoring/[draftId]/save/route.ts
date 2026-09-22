import { NextRequest, NextResponse } from "next/server";
import { FormatAlreadyExistsError, saveFormat } from "@backend/authoring/save";
import { draftExists } from "../../../../lib/authoring";

/**
 * Saves a reviewed/edited draft as a real formats/<id>.json — the moment a
 * draft graduates from authoring/ into the format library. The client
 * sends the FULL edited format object (whatever the reviewer changed,
 * structured fields or the raw-JSON escape hatch), re-validated here
 * against the exact same FormatSchema loadFormat() uses, including its
 * cross-reference refinements — a draft that looked fine in the review UI
 * can still fail this if an edit broke an anchor/event reference.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  if (!draftExists(draftId)) {
    return NextResponse.json({ error: "draft not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  try {
    const { formatId } = saveFormat(body);
    return NextResponse.json({ formatId }, { status: 201 });
  } catch (err) {
    if (err instanceof FormatAlreadyExistsError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

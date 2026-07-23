import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { FormatSchema } from "@backend/pipeline/schemas";
import { formatsDir } from "@backend/pipeline/paths";
import { draftExists } from "../../../../lib/authoring";
import { formatExists } from "../../../../lib/formats";

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
  const parsed = FormatSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `format failed validation:\n${z.prettifyError(parsed.error)}` },
      { status: 400 },
    );
  }

  const format = parsed.data;
  if (formatExists(format.id)) {
    return NextResponse.json(
      { error: `a format with id "${format.id}" already exists — change the id and try again` },
      { status: 409 },
    );
  }

  fs.mkdirSync(formatsDir, { recursive: true });
  fs.writeFileSync(path.join(formatsDir, `${format.id}.json`), JSON.stringify(format, null, 2));
  return NextResponse.json({ formatId: format.id }, { status: 201 });
}

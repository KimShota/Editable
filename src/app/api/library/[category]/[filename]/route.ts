import { NextResponse } from "next/server";
import { deleteLibraryAsset, duplicateLibraryAsset, isLibraryCategory } from "../../../../lib/library";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ category: string; filename: string }> },
) {
  const { category, filename } = await params;
  if (!isLibraryCategory(category)) {
    return NextResponse.json({ error: `invalid category "${category}"` }, { status: 400 });
  }
  deleteLibraryAsset(category, decodeURIComponent(filename));
  return NextResponse.json({ ok: true });
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ category: string; filename: string }> },
) {
  const { category, filename } = await params;
  if (!isLibraryCategory(category)) {
    return NextResponse.json({ error: `invalid category "${category}"` }, { status: 400 });
  }
  const asset = duplicateLibraryAsset(category, decodeURIComponent(filename));
  return NextResponse.json({ asset }, { status: 201 });
}

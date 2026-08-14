import { NextResponse } from "next/server";
import { deleteLibraryAsset, duplicateLibraryAsset, isLibraryCategory } from "../../../../lib/library";
import { getRequestUser } from "../../../../lib/auth";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ category: string; filename: string }> },
) {
  const user = await getRequestUser();
  if (!user) {
    return NextResponse.json({ error: "log in required" }, { status: 401 });
  }
  const { category, filename } = await params;
  if (!isLibraryCategory(category)) {
    return NextResponse.json({ error: `invalid category "${category}"` }, { status: 400 });
  }
  try {
    deleteLibraryAsset(user.id, category, decodeURIComponent(filename));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ category: string; filename: string }> },
) {
  const user = await getRequestUser();
  if (!user) {
    return NextResponse.json({ error: "log in required" }, { status: 401 });
  }
  const { category, filename } = await params;
  if (!isLibraryCategory(category)) {
    return NextResponse.json({ error: `invalid category "${category}"` }, { status: 400 });
  }
  try {
    const asset = duplicateLibraryAsset(user.id, category, decodeURIComponent(filename));
    return NextResponse.json({ asset }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

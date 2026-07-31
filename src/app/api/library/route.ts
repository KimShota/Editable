import { NextRequest, NextResponse } from "next/server";
import { isLibraryCategory, listLibraryAssets, saveLibraryAsset } from "../../lib/library";

export async function GET(req: NextRequest) {
  const category = req.nextUrl.searchParams.get("category");
  if (category === null) {
    return NextResponse.json({ assets: listLibraryAssets() });
  }
  if (!isLibraryCategory(category)) {
    return NextResponse.json({ error: `invalid category "${category}"` }, { status: 400 });
  }
  return NextResponse.json({ assets: listLibraryAssets(category) });
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const category = formData.get("category");
  const file = formData.get("file");
  if (typeof category !== "string" || !isLibraryCategory(category)) {
    return NextResponse.json({ error: `invalid category "${category}"` }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing file" }, { status: 400 });
  }
  const asset = saveLibraryAsset(category, file.name, Buffer.from(await file.arrayBuffer()));
  return NextResponse.json({ asset }, { status: 201 });
}

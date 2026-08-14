import { NextRequest, NextResponse } from "next/server";
import { isLibraryCategory, listLibraryAssets, saveLibraryAsset } from "../../lib/library";
import { getRequestUser } from "../../lib/auth";
import { MAX_LIBRARY_ASSET_BYTES } from "../../lib/uploadLimits";

export async function GET(req: NextRequest) {
  // Middleware already 401s an unauthenticated request before it reaches
  // here — see api/jobs/[jobId]/build/route.ts's identical check for why a
  // null user would mean that guarantee broke, not a real anonymous caller.
  const user = await getRequestUser();
  if (!user) {
    return NextResponse.json({ error: "log in required" }, { status: 401 });
  }

  const category = req.nextUrl.searchParams.get("category");
  if (category === null) {
    return NextResponse.json({ assets: listLibraryAssets(user.id) });
  }
  if (!isLibraryCategory(category)) {
    return NextResponse.json({ error: `invalid category "${category}"` }, { status: 400 });
  }
  return NextResponse.json({ assets: listLibraryAssets(user.id, category) });
}

export async function POST(req: NextRequest) {
  const user = await getRequestUser();
  if (!user) {
    return NextResponse.json({ error: "log in required" }, { status: 401 });
  }

  const formData = await req.formData();
  const category = formData.get("category");
  const file = formData.get("file");
  if (typeof category !== "string" || !isLibraryCategory(category)) {
    return NextResponse.json({ error: `invalid category "${category}"` }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing file" }, { status: 400 });
  }
  if (file.size > MAX_LIBRARY_ASSET_BYTES) {
    return NextResponse.json(
      { error: `"${file.name}" is too large (max ${Math.round(MAX_LIBRARY_ASSET_BYTES / (1024 * 1024))}MB)` },
      { status: 413 },
    );
  }
  const asset = saveLibraryAsset(user.id, category, file.name, Buffer.from(await file.arrayBuffer()));
  return NextResponse.json({ asset }, { status: 201 });
}

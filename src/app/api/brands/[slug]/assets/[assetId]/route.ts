import { NextResponse } from "next/server";
import { brandRoute } from "../../../../../lib/brandApi";
import { brandRepo } from "../../../../../lib/brandRepo";

/** DELETE /api/brands/<slug>/assets/<assetId>: removes an asset of this brand (and its file). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ slug: string; assetId: string }> }) {
  const { slug, assetId } = await params;
  return brandRoute(slug, async () => {
    if (!/^[0-9a-f-]{36}$/i.test(assetId) || !(await brandRepo.removeProductAsset(slug, assetId))) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  });
}

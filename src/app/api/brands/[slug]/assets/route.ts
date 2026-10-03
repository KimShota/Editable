import { NextResponse } from "next/server";
import { MAX_VIDEO_BYTES, UploadError } from "@backend/brand/uploads";
import { SettingsError } from "@backend/brand/settings";
import { brandRoute, ConflictError } from "../../../../lib/brandApi";
import { brandRepo } from "../../../../lib/brandRepo";

/**
 * POST /api/brands/<slug>/assets (multipart: kind, file): a product photo,
 * screenshot, screen recording or logo. What the file really is is decided
 * from its first bytes, not its name (backend/brand/uploads.ts).
 */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return brandRoute(slug, async () => {
    const form = await req.formData().catch(() => null);
    const kind = form?.get("kind");
    const file = form?.get("file");
    if (typeof kind !== "string" || !(file instanceof File)) return NextResponse.json({ error: "Choose a file and say what it is." }, { status: 400 });
    // Before reading it into memory.
    if (file.size > MAX_VIDEO_BYTES) return NextResponse.json({ error: `That file is too large. The most is ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)} MB.` }, { status: 413 });
    try {
      const asset = await brandRepo.addProductAsset(slug, { kind, bytes: Buffer.from(await file.arrayBuffer()) });
      return NextResponse.json({ ok: true, asset });
    } catch (err) {
      if (err instanceof UploadError) return NextResponse.json({ error: err.message }, { status: err.status });
      if (err instanceof SettingsError) throw new ConflictError(err.message);
      throw err;
    }
  });
}

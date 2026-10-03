import { NextResponse } from "next/server";
import { SettingsError } from "@backend/brand/settings";
import { brandRoute, ConflictError } from "../../../../lib/brandApi";
import { brandRepo } from "../../../../lib/brandRepo";

/**
 * PATCH /api/brands/<slug>/settings { brand?, product?, kit? }: what the
 * customer may change about their brand (backend/brand/settings.ts). Only
 * the fields sent change. The character, the voice and this cycle's angle
 * are locked and are not accepted here.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return brandRoute(slug, async () => {
    const body = await req.json().catch(() => ({}));
    try {
      return NextResponse.json({ ok: true, settings: await brandRepo.updateSettings(slug, body) });
    } catch (err) {
      if (err instanceof SettingsError) throw new ConflictError(err.message);
      throw err;
    }
  });
}

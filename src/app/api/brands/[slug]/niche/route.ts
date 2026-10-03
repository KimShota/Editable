import { NextResponse } from "next/server";
import { z } from "zod";
import { chooseNiche, NicheError } from "@backend/niche/choose";
import { getStorage } from "@backend/storage";
import { brandRoute, ConflictError, readJsonBody } from "../../../../lib/brandApi";

/** POST /api/brands/<slug>/niche { angleId }: picks the angle the cycle is
 *  about. Locked once a plan carries one (backend/niche/choose.ts). */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return brandRoute(slug, async () => {
    const { angleId } = await readJsonBody(req, z.object({ angleId: z.string().min(1).max(80) }));
    try {
      return NextResponse.json({ ok: true, ...(await chooseNiche(getStorage(), slug, angleId)) });
    } catch (err) {
      if (err instanceof NicheError) throw new ConflictError(err.message);
      throw err;
    }
  });
}

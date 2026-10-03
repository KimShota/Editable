import { NextResponse } from "next/server";
import { costCsv, readVideoCosts, summarizeCosts } from "@backend/brand/costs";
import { getRequestUser } from "../../../../../lib/auth";
import { BrandAccessError, brandRepo } from "../../../../../lib/brandRepo";
import { getStorage } from "@backend/storage";
import { isBrandSlug } from "@backend/brand/keys";

/** GET /api/admin/brands/<slug>/cost: the measured cost of every produced
 *  video as CSV, for the pitch package. Founder only. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await getRequestUser();
  if (!user?.isAdmin || !isBrandSlug(slug)) return NextResponse.json({ error: "not found" }, { status: 404 });
  // A brand that does not exist is not an empty spreadsheet.
  try {
    await brandRepo.assertAccess(user, slug);
  } catch (err) {
    if (err instanceof BrandAccessError) return NextResponse.json({ error: "not found" }, { status: 404 });
    throw err;
  }
  const plan = await brandRepo.getPlan(slug);
  const rows = [];
  for (const card of [...(plan?.cards ?? [])].sort((a, b) => a.day - b.day)) {
    const entries = await readVideoCosts(getStorage(), slug, card.id);
    if (entries.length > 0) rows.push({ cardId: card.id, day: card.day, breakdown: summarizeCosts(entries) });
  }
  return new NextResponse(costCsv(rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${slug}-cost-per-video.csv"`, "Cache-Control": "no-store" } });
}

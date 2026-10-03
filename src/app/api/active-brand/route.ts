import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "../../lib/auth";
import { ACTIVE_BRAND_COOKIE } from "../../lib/activeBrand";
import { BrandAccessError, brandRepo } from "../../lib/brandRepo";

/**
 * POST { slug } — remembers which brand the sidebar's switcher chose.
 * Cookies can only be set from a route handler or server action, not while
 * rendering (see the Next cookies() docs), which is why this exists. The
 * brand must be one the user may open.
 */
export async function POST(req: NextRequest) {
  const user = await getRequestUser();
  if (!user) return NextResponse.json({ error: "log in required" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { slug?: unknown } | null;
  if (typeof body?.slug !== "string") return NextResponse.json({ error: "slug required" }, { status: 400 });

  try {
    await brandRepo.assertAccess(user, body.slug);
  } catch (err) {
    if (err instanceof BrandAccessError) return NextResponse.json({ error: "not found" }, { status: 404 });
    throw err;
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACTIVE_BRAND_COOKIE, body.slug, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}

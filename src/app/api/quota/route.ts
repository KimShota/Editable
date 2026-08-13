import { NextResponse } from "next/server";
import { getRequestUser } from "../../lib/auth";
import { getQuotaStatus } from "../../lib/quota";

/**
 * Read-only peek at the current user's remaining daily build/render quota —
 * for the "N videos left today" indicators (Nav's server-rendered badge
 * covers page loads outside the editor; this route is what the editor's own
 * client-side top bar polls, since it can't call quota.ts directly). Never
 * records an attempt itself — see getQuotaStatus's own doc comment.
 */
export async function GET() {
  // Middleware already 401s an unauthenticated request before it reaches
  // here — see build/route.ts's identical check for why a null user would
  // mean that guarantee broke, not a real anonymous caller.
  const user = await getRequestUser();
  if (!user) {
    return NextResponse.json({ error: "log in required" }, { status: 401 });
  }
  return NextResponse.json(await getQuotaStatus(user));
}

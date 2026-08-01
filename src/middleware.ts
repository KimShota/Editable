import { NextRequest, NextResponse } from "next/server";

/**
 * Gates the whole app behind the marketing landing page + waitlist when
 * NEXT_PUBLIC_APP_ENABLED is "false" — for deploying just the waitlist to
 * Vercel before the product (spawned child processes, local-disk jobs/
 * artifacts, no auth) has real cloud infrastructure to run on. Unset or
 * any value other than "false" means fully enabled, so local dev and any
 * environment that doesn't set the flag are unaffected.
 *
 * Allow-list, not deny-list: anything not explicitly permitted 404s, so a
 * new route added later doesn't accidentally leak an on-disk-backed API
 * onto a stateless deploy just because nobody remembered to block it.
 */
const ALLOWED_PATHS = new Set(["/", "/api/waitlist"]);

export function middleware(req: NextRequest) {
  if (process.env.NEXT_PUBLIC_APP_ENABLED === "false" && !ALLOWED_PATHS.has(req.nextUrl.pathname)) {
    return new NextResponse("Not found", { status: 404 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

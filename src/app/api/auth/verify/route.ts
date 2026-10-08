import { NextRequest, NextResponse } from "next/server";
import { consumeVerificationToken } from "../../../lib/emailVerification";
import { publicOrigin } from "../../../lib/publicOrigin";

/**
 * Public (see middleware.ts's PUBLIC_PREFIXES: /api/auth/) — this is a link
 * clicked straight out of an email client, possibly in a browser with no
 * session of its own. The token itself is the credential; whoever holds it
 * proved they can read that inbox. Redirects to /workspace either way, which
 * middleware will bounce to /login first if this browser isn't already
 * signed in — the query param survives that round trip and still renders
 * once they are.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  const result = token
    ? await consumeVerificationToken(token)
    : { ok: false as const, error: "missing verification token" };

  // Not req.nextUrl.clone(): in a route handler behind Caddy that is
  // https://localhost:3100, which sent a verified person to an address only the
  // server can open (publicOrigin.ts).
  const url = new URL("/workspace", publicOrigin(req));
  url.searchParams.set(result.ok ? "verified" : "verify_error", result.ok ? "1" : result.error);
  return NextResponse.redirect(url);
}

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, SESSION_COOKIE } from "../../../lib/auth";
import { issueVerificationEmail } from "../../../lib/emailVerification";

/**
 * Public per middleware.ts's PUBLIC_PREFIXES (/api/auth/) like the rest of
 * this directory, so it reads the session directly (same pattern as
 * logout/route.ts) rather than relying on middleware's trusted headers,
 * which are never set on a public route.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req.cookies.get(SESSION_COOKIE)?.value);
  if (!user) {
    return NextResponse.json({ error: "log in required" }, { status: 401 });
  }
  if (user.emailVerifiedAt) {
    return NextResponse.json({ error: "this email is already verified" }, { status: 400 });
  }

  try {
    await issueVerificationEmail(user.id, user.email, req.nextUrl.origin);
  } catch (err) {
    console.error(`resend-verification: failed to send to ${user.email}`, err);
    return NextResponse.json({ error: "could not send the email — try again shortly" }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}

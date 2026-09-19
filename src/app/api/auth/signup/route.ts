import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSession, signup, SESSION_COOKIE, SESSION_TTL_MS } from "../../../lib/auth";
import { issueVerificationEmail } from "../../../lib/emailVerification";

/**
 * Open signup — see auth.ts's signup().
 */

const SignupSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(8).max(200),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = SignupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "a valid email and a password of at least 8 characters are required" }, { status: 400 });
  }

  const result = await signup(parsed.data.email, parsed.data.password);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  // Best-effort AND fire-and-forget: a transient Resend outage shouldn't
  // fail account creation itself — the account page's "resend" button (see
  // resend-verification's route) covers a lost/failed send. Not awaited,
  // since Resend's own API latency (frequently 1-3s) has no reason to hold
  // up the signup response the browser is waiting on; this process stays
  // alive to finish the send regardless (a persistent Node server, not a
  // serverless one that'd kill it the moment the response goes out).
  issueVerificationEmail(result.user.id, result.user.email, req.nextUrl.origin).catch((err) => {
    console.error(`signup: failed to send verification email to ${result.user.email}`, err);
  });

  const token = await createSession(result.user.id, req.headers.get("user-agent") ?? undefined);
  const res = NextResponse.json({ ok: true, user: { email: result.user.email } }, { status: 201 });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return res;
}

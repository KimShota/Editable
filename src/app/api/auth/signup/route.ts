import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSession, signup, SESSION_COOKIE, SESSION_TTL_MS } from "../../../lib/auth";

/**
 * Invite-gated signup — see auth.ts's signup() for why this can't be an
 * open registration form. A bad/used invite code is a 400, not a 404/403:
 * there's nothing sensitive to hide about invite codes themselves (they're
 * handed out by the user directly, not guessed).
 */

const SignupSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(8).max(200),
  inviteCode: z.string().min(1).max(100),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = SignupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "a valid email, a password of at least 8 characters, and an invite code are required" }, { status: 400 });
  }

  const result = await signup(parsed.data.email, parsed.data.password, parsed.data.inviteCode);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

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

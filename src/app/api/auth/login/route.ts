import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSession, verifyLogin, SESSION_COOKIE, SESSION_TTL_MS } from "../../../lib/auth";
import { isLoginRateLimited, recordLoginAttempt } from "../../../lib/loginAttempts";

const LoginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(200),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;

  // Checked BEFORE verifyLogin so a caller already over the limit doesn't
  // get to spend a scrypt hash on yet another guess — see loginAttempts.ts.
  if (await isLoginRateLimited(parsed.data.email, ip)) {
    return NextResponse.json({ error: "too many attempts — try again later" }, { status: 429 });
  }

  // Same message either way — don't let a login form confirm which emails
  // have accounts.
  const user = await verifyLogin(parsed.data.email, parsed.data.password);
  await recordLoginAttempt(parsed.data.email, ip);
  if (!user) {
    return NextResponse.json({ error: "invalid email or password" }, { status: 401 });
  }

  const token = await createSession(user.id, req.headers.get("user-agent") ?? undefined);
  const res = NextResponse.json({ ok: true, user: { email: user.email } }, { status: 200 });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return res;
}

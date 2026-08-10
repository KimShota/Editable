import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSession, verifyLogin, SESSION_COOKIE, SESSION_TTL_MS } from "../../../lib/auth";

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

  // Same message either way — don't let a login form confirm which emails
  // have accounts.
  const user = await verifyLogin(parsed.data.email, parsed.data.password);
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

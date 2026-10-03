import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getRequestUser } from "../../../lib/auth";
import { DEMO_COOKIE } from "../../../lib/demo";

/** POST { on } — turns demo mode on or off for this browser. Founder only
 *  (the proxy hides /api/admin from everyone else; this checks again). */
export async function POST(req: NextRequest) {
  const user = await getRequestUser();
  if (!user?.isAdmin) return NextResponse.json({ error: "not found" }, { status: 404 });
  const parsed = z.object({ on: z.boolean() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "on (true or false) is required" }, { status: 400 });

  const res = NextResponse.json({ ok: true, on: parsed.data.on });
  if (parsed.data.on) res.cookies.set(DEMO_COOKIE, "1", { path: "/", httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 60 * 60 * 12 });
  else res.cookies.delete(DEMO_COOKIE);
  return res;
}

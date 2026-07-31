import { NextRequest, NextResponse } from "next/server";
import { addToWaitlist, hashIp, recentSignupCountFromIp, WaitlistSignupSchema } from "../../lib/waitlist";

/**
 * Public, unauthenticated endpoint — the landing page's "/#waitlist" form
 * posts here. Duplicates return 200 (a waitlist has no reason to hide
 * membership); a honeypot field silently no-ops instead of erroring, so
 * a bot filling it gets a convincing "success" and nothing is stored.
 */

const RATE_LIMIT_PER_HOUR = 5;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }

  // Honeypot: a real user never fills this (it's visually hidden). Lie to
  // the bot rather than telling it what tripped the filter.
  if (typeof body.company === "string" && body.company.trim().length > 0) {
    return NextResponse.json({ status: "added" }, { status: 200 });
  }

  const parsed = WaitlistSignupSchema.safeParse({
    email: body.email,
    referrer: body.referrer,
    utmSource: body.utmSource,
    utmMedium: body.utmMedium,
    utmCampaign: body.utmCampaign,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "a valid email is required" }, { status: 400 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "";
  const ipHash = ip ? hashIp(ip) : undefined;

  try {
    if (ipHash) {
      const recent = await recentSignupCountFromIp(ipHash);
      if (recent >= RATE_LIMIT_PER_HOUR) {
        return NextResponse.json({ error: "too many signups, try again later" }, { status: 429 });
      }
    }

    const result = await addToWaitlist(parsed.data, {
      userAgent: req.headers.get("user-agent") ?? undefined,
      ipHash,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error("waitlist signup failed:", err);
    return NextResponse.json({ error: "something went wrong, try again" }, { status: 500 });
  }
}

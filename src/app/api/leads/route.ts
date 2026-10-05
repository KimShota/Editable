import { NextRequest, NextResponse } from "next/server";
import { sendLeadNotificationEmail } from "../../lib/email";
import { cleanUtm, completeLead, createLead, normalizeEmail, normalizeWebsite, rateLimited } from "../../lib/leads";

/**
 * Landing-page lead capture. Public per proxy.ts's PUBLIC_PREFIXES, so it
 * reads nothing from the session. Two steps from the same form:
 *   { step: "website", website, referrer?, utm?, company? } → { id, brand }
 *   { step: "email", id, email }                            → { ok, brand }
 * `company` is a honeypot field no visitor sees; a bot that fills it gets a
 * fake success and nothing is stored.
 *
 * LANDING_CTA_MODE=onboarding is the later switch (plan section 3): the page
 * then sends the visitor to /signup instead of calling this, so nothing here
 * changes when it flips.
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (rateLimited(ip)) return NextResponse.json({ error: "too many tries — please try again later" }, { status: 429 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  if (typeof body.company === "string" && body.company) {
    return NextResponse.json({ id: "00000000-0000-0000-0000-000000000000", ok: true, brand: "your brand" });
  }

  if (body.step === "website") {
    const site = typeof body.website === "string" ? normalizeWebsite(body.website) : null;
    if (!site) return NextResponse.json({ error: "that doesn't look like a website — try yourbrand.com" }, { status: 400 });
    const referrer = typeof body.referrer === "string" && body.referrer ? body.referrer.slice(0, 300) : null;
    try {
      const id = await createLead(site.url, referrer, cleanUtm(body.utm));
      return NextResponse.json({ id, brand: site.host });
    } catch (err) {
      console.error("leads: could not store the website", err);
      return NextResponse.json({ error: "something went wrong — please try again" }, { status: 500 });
    }
  }

  if (body.step === "email") {
    const email = typeof body.email === "string" ? normalizeEmail(body.email) : null;
    const id = typeof body.id === "string" ? body.id : "";
    if (!email) return NextResponse.json({ error: "that email doesn't look right" }, { status: 400 });
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "bad request" }, { status: 400 });
    try {
      const lead = await completeLead(id, email);
      if (!lead) return NextResponse.json({ error: "this request was already completed — paste your website again" }, { status: 409 });
      const notify = process.env.LEADS_NOTIFY_EMAIL;
      if (notify) {
        // The lead is already stored; a failed notification must not fail the visitor.
        await sendLeadNotificationEmail(notify, { website: lead.website, email, referrer: lead.referrer, utm: lead.utm }).catch((err) =>
          console.error("leads: could not email the founder", err),
        );
      } else {
        console.warn("leads: LEADS_NOTIFY_EMAIL is not set — the lead is stored but nobody was emailed");
      }
      return NextResponse.json({ ok: true, brand: new URL(lead.website).hostname.replace(/^www\./, "") });
    } catch (err) {
      console.error("leads: could not store the email", err);
      return NextResponse.json({ error: "something went wrong — please try again" }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "bad request" }, { status: 400 });
}

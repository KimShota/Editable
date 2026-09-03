import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "../../../lib/auth";
import { getBillingStatus } from "../../../lib/billing";
import { stripe } from "../../../lib/stripe";

/**
 * Opens Stripe's hosted Billing Portal for the current user — how a
 * Premium subscriber cancels or updates payment. Stripe owns that whole
 * flow (see webhook route's customer.subscription.deleted handler for how
 * a cancellation there gets reflected back to plan='free'); the app has no
 * cancel button of its own.
 */
export async function POST(req: NextRequest) {
  const user = await getRequestUser();
  if (!user) {
    return NextResponse.json({ error: "log in required" }, { status: 401 });
  }

  const { stripeCustomerId } = await getBillingStatus(user);
  if (!stripeCustomerId) {
    return NextResponse.json({ error: "no billing account on file" }, { status: 400 });
  }

  const origin = req.nextUrl.origin;
  const session = await stripe().billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${origin}/account`,
  });

  return NextResponse.json({ url: session.url });
}

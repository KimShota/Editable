import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "../../../lib/auth";
import { getOrCreateStripeCustomerId } from "../../../lib/billing";
import { premiumPriceId, stripe } from "../../../lib/stripe";

/**
 * Starts a Stripe Checkout session for the $50/month Premium subscription.
 * Redirect-based, not Stripe.js/Elements — so this returns a URL for the
 * client to navigate to rather than doing anything itself with cards.
 */
export async function POST(req: NextRequest) {
  const user = await getRequestUser();
  if (!user) {
    return NextResponse.json({ error: "log in required" }, { status: 401 });
  }
  if (user.plan === "premium") {
    return NextResponse.json({ error: "you're already subscribed to Premium" }, { status: 400 });
  }

  const customerId = await getOrCreateStripeCustomerId(user);
  const origin = req.nextUrl.origin;

  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{ price: premiumPriceId(), quantity: 1 }],
    success_url: `${origin}/account?upgraded=1`,
    cancel_url: `${origin}/pricing`,
  });

  if (!session.url) {
    return NextResponse.json({ error: "could not start checkout" }, { status: 502 });
  }
  return NextResponse.json({ url: session.url });
}

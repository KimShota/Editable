import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { setUserPlan } from "../../../lib/billing";
import { stripe } from "../../../lib/stripe";

/**
 * Stripe → app sync point. Public (see middleware.ts's PUBLIC_PREFIXES) —
 * Stripe can't send our session cookie, so the signature check below is
 * this route's entire auth boundary, not the app's normal session gate.
 *
 * Resolves the target user via stripe_customer_id (present on every event
 * we handle) rather than client_reference_id, which only exists on the
 * initial checkout.session.completed event — a later subscription update
 * or cancellation (from Stripe's dashboard, or dunning) has no
 * client_reference_id to fall back on.
 */
export async function POST(req: NextRequest) {
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing signature" }, { status: 400 });
  }

  // Raw bytes, not req.json() — signature verification needs the exact
  // string Stripe signed.
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET ?? "");
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
      const subscriptionId =
        typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
      if (customerId) {
        await setUserPlan({ stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId ?? null, plan: "premium" });
      }
      break;
    }
    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
      // active/trialing = paying (or in a Stripe-managed trial); anything
      // else (past_due, unpaid, canceled, incomplete_expired) demotes.
      const plan = subscription.status === "active" || subscription.status === "trialing" ? "premium" : "free";
      await setUserPlan({
        stripeCustomerId: customerId,
        stripeSubscriptionId: plan === "premium" ? subscription.id : null,
        plan,
      });
      break;
    }
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
      await setUserPlan({ stripeCustomerId: customerId, stripeSubscriptionId: null, plan: "free" });
      break;
    }
    default:
      break;
  }

  return NextResponse.json({ received: true });
}

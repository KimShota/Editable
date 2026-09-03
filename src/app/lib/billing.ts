import "server-only";
import { sql } from "./db";
import { stripe } from "./stripe";
import type { SessionUser } from "./session";

/**
 * All Stripe-related `users` SQL lives here, same as quota.ts owns all
 * pipeline_runs SQL — route handlers stay thin and there's one place that
 * can drift on what a plan/customer mapping means.
 */

export type Plan = "free" | "premium";

/** Reuses users.stripe_customer_id if already set; otherwise creates a
 *  Stripe customer and persists it. metadata.userId gives the webhook a
 *  second way to resolve an event back to a user, though in practice every
 *  event we handle carries `customer` directly. */
export const getOrCreateStripeCustomerId = async (user: SessionUser): Promise<string> => {
  const rows = await sql`select stripe_customer_id from users where id = ${user.id}`;
  const existing = (rows[0] as { stripe_customer_id: string | null } | undefined)?.stripe_customer_id;
  if (existing) return existing;

  const customer = await stripe().customers.create({
    email: user.email,
    metadata: { userId: user.id },
  });
  await sql`update users set stripe_customer_id = ${customer.id} where id = ${user.id}`;
  return customer.id;
};

/** The single write path for plan changes — used by the webhook so three
 *  event handlers don't each carry their own near-duplicate UPDATE. Matches
 *  on stripe_customer_id, which every event we handle carries. */
export const setUserPlan = async (input: {
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  plan: Plan;
}): Promise<void> => {
  await sql`
    update users
    set plan = ${input.plan}, stripe_subscription_id = ${input.stripeSubscriptionId}
    where stripe_customer_id = ${input.stripeCustomerId}
  `;
};

export const getBillingStatus = async (
  user: SessionUser,
): Promise<{ plan: Plan; stripeCustomerId: string | null; stripeSubscriptionId: string | null }> => {
  const rows = await sql`
    select plan, stripe_customer_id, stripe_subscription_id from users where id = ${user.id}
  `;
  const row = rows[0] as { plan: Plan; stripe_customer_id: string | null; stripe_subscription_id: string | null };
  return { plan: row.plan, stripeCustomerId: row.stripe_customer_id, stripeSubscriptionId: row.stripe_subscription_id };
};

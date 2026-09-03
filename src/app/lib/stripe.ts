import "server-only";
import Stripe from "stripe";

/**
 * Lazy on purpose, same reasoning as db.ts's sql client: constructing this
 * eagerly would throw at module import when STRIPE_SECRET_KEY is unset,
 * 500-ing every route that imports this file even if the request never
 * touches billing.
 */
let client: Stripe | undefined;

export const stripe = (): Stripe => {
  if (!client) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY is not set — see .env for Stripe setup.");
    }
    client = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return client;
};

/** The recurring $50/month Premium price, created once in the Stripe
 *  dashboard — see .env for setup notes. */
export const premiumPriceId = (): string => {
  if (!process.env.STRIPE_PREMIUM_PRICE_ID) {
    throw new Error("STRIPE_PREMIUM_PRICE_ID is not set — see .env for Stripe setup.");
  }
  return process.env.STRIPE_PREMIUM_PRICE_ID;
};

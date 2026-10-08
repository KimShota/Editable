/**
 * The address people reach this app at, for links we put in emails and hand to
 * Stripe. `req.nextUrl.origin` is wrong in production: Next runs behind Caddy
 * on localhost:3100, so it reports `https://localhost:3100` and every emailed
 * link (verification, invites, "your videos are ready") and Stripe's
 * success/return URLs pointed at an address nobody outside the server can open.
 *
 * APP_ORIGIN (e.g. https://katalab.art) names the public address. It is set on
 * the server, never read from a request header: a forwarded Host that a client
 * can set would let anyone get a link to their own site into an email we send.
 * Unset (local development), the request's own origin is right and is used.
 *
 * Pure on purpose (no server-only) so uiDataChecks.ts can exercise it.
 */
export const publicOrigin = (req: { url: string }, env: Record<string, string | undefined> = process.env): string => {
  const configured = env.APP_ORIGIN?.trim();
  if (configured) {
    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      throw new Error(`APP_ORIGIN is not a web address: "${configured}" (expected e.g. https://katalab.art)`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`APP_ORIGIN must start with https:// or http://, got "${configured}"`);
    }
    return url.origin;
  }
  return new URL(req.url).origin;
};

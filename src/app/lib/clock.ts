/**
 * "Now" for the app. In the test environment (KATALAB_STUB_PROVIDERS=1)
 * KATALAB_NOW can fix it, so a screen that depends on today's date (the
 * calendar's today ring, its countdown) can be tested on a known day. Anywhere
 * else the variable is ignored, so a stray value can never move a real
 * customer's calendar.
 */
export const now = (): Date => {
  const fixed = process.env.KATALAB_STUB_PROVIDERS === "1" ? process.env.KATALAB_NOW : undefined;
  const parsed = fixed ? new Date(fixed) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
};

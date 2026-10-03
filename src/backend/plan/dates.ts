/**
 * Dates of a plan. `startsOn` is a plain calendar date (the brand's own
 * "day 1"), so everything here works in UTC on YYYY-MM-DD strings: parsing
 * "2026-10-09" as local time and formatting it back would shift it a day
 * for anyone west or east of the server.
 */

const parse = (isoDate: string): Date => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error(`expected YYYY-MM-DD, got "${isoDate}"`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCMonth() !== Number(m[2]) - 1) throw new Error(`not a real date: "${isoDate}"`);
  return d;
};

const iso = (d: Date): string => d.toISOString().slice(0, 10);

export const addDays = (isoDate: string, days: number): string => {
  const d = parse(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
};

/** The date of card `day` (1-based) in a cycle that starts on `startsOn`. */
export const dateOfDay = (startsOn: string, day: number): string => addDays(startsOn, day - 1);

/** Whole days from `a` to `b` (negative when b is earlier). */
export const daysBetween = (a: string, b: string): number => Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);

/** "Oct 9", or "Fri, Oct 9" with `weekday`. */
export const formatDate = (isoDate: string, opts: { weekday?: boolean } = {}): string =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", ...(opts.weekday ? { weekday: "short" } : {}) }).format(parse(isoDate));

/** Monday = 0 … Sunday = 6, for laying a cycle out on a Mon–Sun grid. */
export const weekdayIndex = (isoDate: string): number => (parse(isoDate).getUTCDay() + 6) % 7;

/** Today's date in a time zone, as YYYY-MM-DD (the brand's own "today"). */
export const todayIn = (timeZone: string, now: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

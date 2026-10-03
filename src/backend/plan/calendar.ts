import type { Card, Plan } from "./schemas";
import { CYCLE_DAYS } from "./schemas";
import { addDays, dateOfDay, daysBetween, weekdayIndex } from "./dates";

/**
 * How a plan sits on a Monday-to-Sunday calendar (plan/ui-ux-full-flow.md §6).
 * Pure: the page passes in today's date, so every case is testable.
 *
 * A cycle starts on any weekday, so its 14 days usually cover three week-rows:
 * the days of the first week before it starts, and of the last week after it
 * ends, are "outside" cells that show nothing.
 */

export type CalendarCell =
  | { kind: "outside"; date: string }
  | { kind: "day"; date: string; day: number; today: boolean; past: boolean; card: Card | null };

export type CalendarWeek = CalendarCell[];

export const layoutCycle = (plan: Pick<Plan, "startsOn" | "cards">, today: string): CalendarWeek[] => {
  const lead = weekdayIndex(plan.startsOn);
  const total = Math.ceil((lead + CYCLE_DAYS) / 7) * 7;
  const byDay = new Map(plan.cards.map((c) => [c.day, c]));
  const cells: CalendarCell[] = [];
  for (let i = 0; i < total; i++) {
    const day = i - lead + 1;
    const date = addDays(plan.startsOn, day - 1);
    cells.push(
      day < 1 || day > CYCLE_DAYS
        ? { kind: "outside", date }
        : { kind: "day", date, day, today: date === today, past: date < today, card: byDay.get(day) ?? null },
    );
  }
  const weeks: CalendarWeek[] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
};

export type CycleSummary = {
  /** Videos that are approved by the customer: ready to post, or already posted. */
  ready: number;
  total: number;
  /** "Cycle 1, Oct 9 to Oct 22" is built by the caller from these. */
  startsOn: string;
  endsOn: string;
  /** What the countdown line says. */
  countdown: string;
};

/** Where in its life the cycle is, in words. The next plan is ready on day 11
 *  (plan §3.6: the review is drafted on day 10, the plan on day 11). */
export const summarizeCycle = (plan: Pick<Plan, "startsOn" | "cards">, today: string): CycleSummary => {
  const endsOn = dateOfDay(plan.startsOn, CYCLE_DAYS);
  const nextPlanOn = dateOfDay(plan.startsOn, 11);
  const untilStart = daysBetween(today, plan.startsOn);
  const untilPlan = daysBetween(today, nextPlanOn);
  const plural = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

  let countdown: string;
  if (untilStart > 0) countdown = `Starts in ${plural(untilStart)}`;
  else if (today > endsOn) countdown = "This cycle has ended";
  else if (untilPlan > 0) countdown = `Next plan in ${plural(untilPlan)}`;
  else countdown = "Your next plan is on its way";

  return {
    ready: plan.cards.filter((c) => c.status === "ready" || c.status === "posted").length,
    total: CYCLE_DAYS,
    startsOn: plan.startsOn,
    endsOn,
    countdown,
  };
};

/** Where a day's card leads: the editor once there is a video the viewer may
 *  open, else the plan review. The visibility rule is plan/status.ts's. */
export const cardHref = (cardId: string, hasVideo: boolean): string => (hasVideo ? `/videos/${cardId}/edit` : `/plan/${cardId}`);

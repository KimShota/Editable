import type { Metadata } from "next";
import { dateOfDay, formatDate } from "@backend/plan/dates";
import { getActiveBrand } from "../../lib/activeBrand";
import { getRequestUser } from "../../lib/auth";
import { brandRepo } from "../../lib/brandRepo";
import { Container, EmptyState, PageHeader, StatusBadge } from "../../_components/ui";

export const metadata: Metadata = { title: "Calendar · Katalab" };

/**
 * Home. For now a dated list of the cycle's cards; the two-week grid,
 * approve-all and manual posting replace this body (plan/ui-ux-full-flow.md
 * §6). Reading goes through brandRepo like every screen.
 */
export default async function CalendarPage() {
  const user = (await getRequestUser())!;
  const { active } = await getActiveBrand(user);

  if (!active) {
    return (
      <Container>
        <PageHeader title="Calendar" />
        <EmptyState title="Your workspace is being set up">We are getting your brand ready. You will see your plan here as soon as it is.</EmptyState>
      </Container>
    );
  }

  const plan = await brandRepo.getPlan(active.slug);
  if (!plan) {
    return (
      <Container>
        <PageHeader kicker={active.name} title="Calendar" />
        <EmptyState title="Your plan is being built">Your first 14 days of videos will appear here.</EmptyState>
      </Container>
    );
  }

  const cards = [...plan.cards].sort((a, b) => a.day - b.day);
  return (
    <Container>
      <PageHeader kicker={active.name} title="Calendar" subtitle={`Cycle ${plan.cycleId} · starts ${formatDate(plan.startsOn, { weekday: true })}`} />
      <ol className="flex flex-col gap-3">
        {cards.map((card) => (
          <li key={card.id} data-card-id={card.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] px-5 py-4">
            <div className="w-24 shrink-0">
              <p className="font-[family-name:var(--font-display)] text-sm font-semibold text-[color:var(--ink)]">Day {card.day}</p>
              <p className="text-[13px] text-[color:var(--ink-dim)]">{formatDate(dateOfDay(plan.startsOn, card.day), { weekday: true })}</p>
            </div>
            <p className="min-w-0 flex-1 basis-64 text-[15px] text-[color:var(--ink)]">{card.hook || card.angle}</p>
            <StatusBadge status={card.status} lowConfidence={card.lowConfidence} audience="customer" />
          </li>
        ))}
      </ol>
    </Container>
  );
}

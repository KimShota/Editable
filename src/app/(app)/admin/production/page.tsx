import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dateOfDay, formatDate } from "@backend/plan/dates";
import { getActiveBrand } from "../../../lib/activeBrand";
import { getRequestUser } from "../../../lib/auth";
import { brandRepo } from "../../../lib/brandRepo";
import { queue } from "../../../lib/tasks";
import { Container, EmptyState, PageHeader, StatusBadge } from "../../../_components/ui";
import { LiveRefresh } from "../../plan/_components/LiveRefresh";
import { AdminTabs } from "../_components/AdminTabs";
import { ProductionActions } from "../_components/ProductionActions";

export const metadata: Metadata = { title: "Production · Katalab" };

const usd = (n: number | undefined): string => (n === undefined ? "not priced" : `$${n.toFixed(2)}`);

/** The production queue: videos the customer approved, waiting for the
 *  founder to release them (which spends money), and the ones in flight. */
export default async function AdminProductionPage() {
  const user = (await getRequestUser())!;
  if (!user.isAdmin) notFound();
  const { active } = await getActiveBrand(user);
  if (!active) {
    return (
      <Container>
        <PageHeader title="Production" />
        <AdminTabs />
        <EmptyState title="No brand yet">Link a brand first (npm run brand:link).</EmptyState>
      </Container>
    );
  }

  const slug = active.slug;
  const [plan, live] = await Promise.all([brandRepo.getPlan(slug), queue.listTasks({ slug, kinds: ["video.produce", "video.estimate"] })]);
  const cards = [...(plan?.cards ?? [])].filter((c) => ["approved", "queued", "generating", "failed"].includes(c.status)).sort((a, b) => a.day - b.day);
  const taskOf = (cardId: string, kind: string) => live.find((t) => t.kind === kind && (t.payload as { cardId?: string }).cardId === cardId)?.id ?? null;
  const waiting = cards.filter((c) => c.status === "approved");
  const total = waiting.reduce((sum, c) => sum + (c.estimateMaxUsd ?? c.estimateUsd ?? 0), 0);

  return (
    <Container>
      <LiveRefresh active={live.length > 0} />
      <PageHeader kicker={active.name} title="Production" subtitle={waiting.length ? `${waiting.length} approved, waiting for you. Releasing spends money.` : "Nothing is waiting for release."} />
      <AdminTabs />

      {cards.length === 0 ? (
        <EmptyState title="The queue is empty">Videos appear here once the customer approves them.</EmptyState>
      ) : (
        <>
          {waiting.length > 0 && <p className="mb-4 text-sm text-[color:var(--ink-dim)]">Releasing everything below could cost up to {usd(total)}.</p>}
          <ul className="flex flex-col gap-3" aria-label="Production queue">
            {cards.map((card) => (
              <li key={card.id} data-card-id={card.id} className="grid gap-4 rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-4 md:grid-cols-[6rem_1fr_14rem_auto] md:items-start">
                <div>
                  <p className="font-[family-name:var(--font-display)] text-sm font-semibold text-[color:var(--ink)]">Day {card.day}</p>
                  <p className="text-[13px] text-[color:var(--ink-dim)]">{plan ? formatDate(dateOfDay(plan.startsOn, card.day), { weekday: true }) : ""}</p>
                </div>
                <div className="min-w-0">
                  <p className="line-clamp-2 text-[15px] font-medium text-[color:var(--ink)]">{card.angle}</p>
                  <div className="mt-1.5">
                    <StatusBadge status={card.status} lowConfidence={card.lowConfidence} audience="admin" />
                  </div>
                </div>
                <div className="text-sm">
                  <p className="text-[color:var(--ink)]" data-testid="estimate">
                    {usd(card.estimateUsd)}
                  </p>
                  {card.estimateMaxUsd !== undefined && card.estimateMaxUsd !== card.estimateUsd && <p className="text-[13px] text-[color:var(--ink-dim)]">up to {usd(card.estimateMaxUsd)} with retries</p>}
                </div>
                <div className="min-w-0 md:w-64">
                  {card.status === "approved" || card.status === "failed" ? (
                    <ProductionActions slug={slug} cardId={card.id} hasEstimate={card.estimateUsd !== undefined} estimateMax={card.estimateMaxUsd ?? card.estimateUsd ?? null} running={taskOf(card.id, "video.estimate")} />
                  ) : (
                    <ProductionActions slug={slug} cardId={card.id} hasEstimate estimateMax={null} running={taskOf(card.id, "video.produce")} />
                  )}
                  {card.status === "failed" && <p className="mt-2 text-[13px] text-[color:var(--st-bad-fg)]">The last run failed. Releasing again pays for a new run.</p>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Container>
  );
}

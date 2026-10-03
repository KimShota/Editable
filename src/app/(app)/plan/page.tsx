import type { Metadata } from "next";
import Link from "next/link";
import { dateOfDay, formatDate } from "@backend/plan/dates";
import { getActiveBrand } from "../../lib/activeBrand";
import { getRequestUser } from "../../lib/auth";
import { brandRepo } from "../../lib/brandRepo";
import { mediaUrl } from "../../lib/mediaUrl";
import { queue } from "../../lib/tasks";
import { Container, EmptyState, PageHeader, StatusBadge } from "../../_components/ui";
import { TaskProgress } from "../../_components/TaskProgress";
import { AddSourceForm } from "./_components/AddSourceForm";
import { LiveRefresh } from "./_components/LiveRefresh";
import { ApproveAllButton, BuildPlanButton } from "./_components/PlanActions";

export const metadata: Metadata = { title: "Plan · Katalab" };

const LIVE_KINDS = ["plan.build", "source.ingest", "card.adapt", "card.storyboard"];

export default async function PlanPage() {
  const user = (await getRequestUser())!;
  const { active } = await getActiveBrand(user);
  if (!active) {
    return (
      <Container>
        <PageHeader title="Plan" />
        <EmptyState title="Your workspace is being set up">We are getting your brand ready. Your plan will appear here as soon as it is.</EmptyState>
      </Container>
    );
  }

  const slug = active.slug;
  const [plan, sources, live] = await Promise.all([brandRepo.getPlan(slug), brandRepo.listSources(slug), queue.listTasks({ slug, kinds: LIVE_KINDS })]);
  const thumbs = new Map(sources.map((s) => [s.sourceId, s.thumbKey]));
  const writing = new Set(live.filter((t) => t.kind === "card.adapt" || t.kind === "card.storyboard").map((t) => (t.payload as { cardId?: string }).cardId));
  const building = live.find((t) => t.kind === "plan.build");
  const ingesting = live.filter((t) => t.kind === "source.ingest");

  const cards = [...(plan?.cards ?? [])].sort((a, b) => a.day - b.day);
  const drafts = cards.filter((c) => c.status === "draft");
  const ready = drafts.filter((c) => c.hook && !writing.has(c.id)).length;
  const approved = cards.filter((c) => c.status !== "draft").length;
  const freeDays = 14 - cards.length;

  return (
    <Container>
      <LiveRefresh active={live.length > 0} />
      <PageHeader
        kicker={active.name}
        title="Plan"
        subtitle={plan ? `${plan.niche ? `${plan.niche.title}. ` : ""}${approved} of ${cards.length} approved. Day 1 is ${formatDate(plan.startsOn, { weekday: true })}.` : "Your first 14 days of videos."}
        actions={plan && cards.length > 0 ? <ApproveAllButton slug={slug} ready={ready} /> : undefined}
      />

      {(building || ingesting.length > 0) && (
        <div className="mb-8 flex flex-col gap-3">
          {building && <TaskProgress taskId={building.id} title="Building your plan" />}
          {ingesting.map((t) => (
            <TaskProgress key={t.id} taskId={t.id} title="Adding a viral video" />
          ))}
        </div>
      )}

      {cards.length === 0 ? (
        <EmptyState
          title="Your plan is being built"
          action={user.isAdmin && !building ? <BuildPlanButton slug={slug} label="Build the 14-day plan" /> : undefined}
        >
          {sources.length === 0 ? "Add a few viral videos below and your first 14 days of videos will be planned from them." : "Your first 14 days of videos will appear here."}
        </EmptyState>
      ) : (
        <ol className="flex flex-col gap-3" aria-label="Videos in this plan">
          {cards.map((card) => {
            const thumb = thumbs.get(card.sourceId);
            const isWriting = writing.has(card.id);
            return (
              <li key={card.id} data-card-id={card.id}>
                <Link
                  href={`/plan/${card.id}`}
                  className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3 rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-4 transition-colors hover:border-[color:var(--card-border-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)] md:grid-cols-[6rem_auto_1fr_auto]"
                >
                  <div className="col-span-2 md:col-span-1">
                    <p className="font-[family-name:var(--font-display)] text-sm font-semibold text-[color:var(--ink)]">Day {card.day}</p>
                    <p className="text-[13px] text-[color:var(--ink-dim)]">{formatDate(dateOfDay(plan!.startsOn, card.day), { weekday: true })}</p>
                  </div>
                  {thumb ? (
                    <img src={mediaUrl(thumb)} alt="" className="h-[4.5rem] w-12 rounded-lg bg-[color:var(--bg-2)] object-cover" />
                  ) : (
                    <div aria-hidden="true" className="h-[4.5rem] w-12 rounded-lg bg-[color:var(--bg-2)]" />
                  )}
                  <div className="min-w-0">
                    <p className="line-clamp-2 text-[15px] font-medium text-[color:var(--ink)]">{card.angle}</p>
                    <p className="mt-0.5 line-clamp-2 text-sm text-[color:var(--ink-dim)]">{card.hook || (isWriting ? "The script is being written." : "No script yet.")}</p>
                  </div>
                  <div className="col-span-2 flex flex-wrap items-center gap-2 md:col-span-1 md:justify-end">
                    {isWriting && <span className="text-[13px] text-[color:var(--ink-dim)]">Writing</span>}
                    <StatusBadge status={card.status} lowConfidence={card.lowConfidence} audience="customer" />
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      )}

      <div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <AddSourceForm slug={slug} />
        {user.isAdmin && freeDays > 0 && cards.length > 0 && (
          <section className="rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-5">
            <h2 className="font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">Fill the plan</h2>
            <p className="mt-1 text-sm text-[color:var(--ink-dim)]">{freeDays} day{freeDays === 1 ? "" : "s"} have no video yet. They are planned from your viral videos.</p>
            <div className="mt-4">
              <BuildPlanButton slug={slug} label={`Plan ${freeDays} more day${freeDays === 1 ? "" : "s"}`} />
            </div>
          </section>
        )}
      </div>
    </Container>
  );
}

import type { Metadata } from "next";
import { sampleAnalytics } from "@backend/plan/sampleAnalytics";
import { getActiveBrand } from "../../../lib/activeBrand";
import { getRequestUser } from "../../../lib/auth";
import { brandRepo } from "../../../lib/brandRepo";
import { isDemoMode } from "../../../lib/demo";
import { Container, EmptyState, PageHeader } from "../../../_components/ui";
import { AnalyticsTabs, SampleBanner, Skeleton } from "../_components/parts";

export const metadata: Metadata = { title: "Cycle review · Katalab" };

const VERDICT = {
  winner: { label: "Winner", cls: "bg-[color:var(--st-ready-bg)] text-[color:var(--st-ready-fg)]" },
  steady: { label: "Steady", cls: "bg-[color:var(--st-queued-bg)] text-[color:var(--st-queued-fg)]" },
  loser: { label: "Weak", cls: "bg-[color:var(--st-bad-bg)] text-[color:var(--st-bad-fg)]" },
} as const;

/**
 * What worked this cycle and what to make next (plan/ui-ux-full-flow.md §7).
 * The real review needs a finished cycle of posted videos, so for a customer
 * this is the layout with an honest empty state. The founder's demo mode shows
 * a labelled sample of what it will look like.
 */
export default async function CycleReviewPage() {
  const user = (await getRequestUser())!;
  const { active } = await getActiveBrand(user);
  if (!active) {
    return (
      <Container>
        <PageHeader title="Cycle review" />
        <EmptyState title="Your workspace is being set up">We are getting your brand ready.</EmptyState>
      </Container>
    );
  }

  const plan = await brandRepo.getPlan(active.slug);
  const sample = (await isDemoMode(user)) && plan ? sampleAnalytics(plan.cards) : null;
  const topics = new Map<string, string>();
  if (sample && plan) {
    for (const f of sample.formats) {
      const spec = await brandRepo.getSpec(active.slug, f.sourceId);
      topics.set(f.sourceId, spec?.topic ?? f.sourceId);
    }
  }

  return (
    <Container>
      <PageHeader kicker={active.name} title="Cycle review" subtitle="Which kinds of video worked, and what to make next." />
      <AnalyticsTabs current="review" />
      {sample && <SampleBanner />}

      <section aria-labelledby="formats-title">
        <h2 id="formats-title" className="font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">Which formats worked</h2>
        {sample ? (
          <ol className="mt-3 flex flex-col gap-3" aria-label="Formats, best first">
            {sample.formats.map((f) => (
              <li key={f.sourceId} className="grid gap-3 rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-4 sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-medium text-[color:var(--ink)]">{topics.get(f.sourceId)}</p>
                  <p className="mt-0.5 text-sm text-[color:var(--ink-dim)]">{f.why}</p>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <span className="tabular-nums text-[color:var(--ink-dim)]">{f.videos} video{f.videos === 1 ? "" : "s"}</span>
                  <span className="tabular-nums font-medium text-[color:var(--ink)]">{f.vsBaseline >= 0 ? "+" : ""}{f.vsBaseline}% vs your usual</span>
                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${VERDICT[f.verdict].cls}`}>{VERDICT[f.verdict].label}</span>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <div className="mt-3 rounded-2xl border border-dashed border-[color:var(--card-border)] px-6 py-10">
            <p className="font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">Your first review comes after your first cycle</p>
            <p className="mt-1 max-w-[65ch] text-sm text-[color:var(--ink-dim)]">Once a cycle&apos;s videos have been posted for a week, we compare each format with your usual numbers and explain what worked, in plain words.</p>
            <div className="mt-5 flex flex-col gap-3" aria-hidden="true">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          </div>
        )}
      </section>

      <section aria-labelledby="next-title" className="mt-10">
        <h2 id="next-title" className="font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">The next cycle</h2>
        <p className="mt-1 max-w-[65ch] text-sm text-[color:var(--ink-dim)]">Most of your next plan repeats what worked. The rest tries something new.</p>
        <div className="mt-4 flex h-3 w-full max-w-xl overflow-hidden rounded-full bg-[color:var(--bg-2)]" role="img" aria-label={sample ? "70 percent winners, 30 percent new ideas" : "Not available yet"}>
          {sample && (
            <>
              <div className="bg-[color:var(--ink)]" style={{ width: `${sample.nextPlan.winners}%` }} />
              <div className="bg-[color:var(--accent)]" style={{ width: `${sample.nextPlan.exploration}%` }} />
            </>
          )}
        </div>
        {sample && (
          <p className="mt-2 text-sm text-[color:var(--ink-dim)]">{sample.nextPlan.winners}% more of what worked, {sample.nextPlan.exploration}% new ideas.</p>
        )}
        <div className="mt-5">
          <button type="button" disabled className="rounded-full bg-[color:var(--ink)] px-6 py-3 font-[family-name:var(--font-display)] text-sm font-bold tracking-wide text-[color:var(--bg)] opacity-40">Draft the next plan</button>
          <p className="mt-2 text-sm text-[color:var(--ink-dim)]">This unlocks when your first cycle has finished.</p>
        </div>
      </section>
    </Container>
  );
}

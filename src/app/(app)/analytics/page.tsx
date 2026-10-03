import type { Metadata } from "next";
import { sampleAnalytics } from "@backend/plan/sampleAnalytics";
import { getActiveBrand } from "../../lib/activeBrand";
import { getRequestUser } from "../../lib/auth";
import { brandRepo } from "../../lib/brandRepo";
import { isDemoMode } from "../../lib/demo";
import { Container, EmptyState, PageHeader } from "../../_components/ui";
import { AnalyticsTabs, SampleBanner, Skeleton, Stat, ViewsChart } from "./_components/parts";

export const metadata: Metadata = { title: "Analytics · Katalab" };

const n = (v: number): string => new Intl.NumberFormat("en").format(v);

/**
 * How the videos are doing (plan/ui-ux-full-flow.md §7). Nothing has been
 * posted by the platform yet, so a customer sees the real layout with honest
 * empty states, and the one real number: how many videos they have marked as
 * posted. The founder's demo mode fills the same layout with labelled sample
 * numbers; they are never shown to anyone else.
 */
export default async function AnalyticsPage() {
  const user = (await getRequestUser())!;
  const { active } = await getActiveBrand(user);
  if (!active) {
    return (
      <Container>
        <PageHeader title="Analytics" />
        <EmptyState title="Your workspace is being set up">We are getting your brand ready.</EmptyState>
      </Container>
    );
  }

  const plan = await brandRepo.getPlan(active.slug);
  const demo = await isDemoMode(user);
  const sample = demo && plan ? sampleAnalytics(plan.cards) : null;
  const posted = (plan?.cards ?? []).filter((c) => c.status === "posted");

  return (
    <Container>
      <PageHeader kicker={active.name} title="Analytics" subtitle="How your videos are doing, once they are posted." />
      <AnalyticsTabs current="overview" />
      {sample && <SampleBanner />}

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Views in the first 7 days" value={sample ? n(sample.totalViews7d) : <Skeleton className="mt-1 h-8 w-24" />} hint={sample ? "Across the sample videos" : "The number we care about most"} sample={!!sample} />
        <Stat label="Engagement rate" value={sample ? `${sample.avgEngagement}%` : <Skeleton className="mt-1 h-8 w-16" />} hint={sample ? "Average across the sample videos" : "Likes, comments and shares per view"} sample={!!sample} />
        <Stat label="Videos posted this cycle" value={sample ? sample.videos.length : posted.length} hint={sample ? "Sample" : "The ones you marked as posted"} sample={!!sample} />
      </div>

      <section aria-labelledby="chart-title" className="mt-8 rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-5">
        <h2 id="chart-title" className="font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">Views per video</h2>
        <div className="mt-3">
          <ViewsChart points={sample?.series ?? []} label={sample ? "Views in the first 7 days for each sample video" : "No views yet"} />
        </div>
        {!sample && <p className="mt-2 text-sm text-[color:var(--ink-dim)]">Your first numbers appear 48 hours after your first post.</p>}
      </section>

      <section aria-labelledby="table-title" className="mt-8">
        <h2 id="table-title" className="font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">Each video</h2>
        {sample ? (
          <div className="mt-3 overflow-x-auto rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)]">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <caption className="sr-only">Sample numbers for each video</caption>
              <thead className="text-[13px] text-[color:var(--ink-dim)]">
                <tr className="border-b border-[color:var(--card-border)]">
                  <th scope="col" className="px-4 py-3 font-medium">Video</th>
                  <th scope="col" className="px-4 py-3 font-medium">Where</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">48 hours</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">7 days</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Engagement</th>
                  <th scope="col" className="px-4 py-3 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {sample.videos.map((v) => (
                  <tr key={v.cardId} className="border-b border-[color:var(--card-border)] last:border-0">
                    <th scope="row" className="max-w-[18rem] truncate px-4 py-3 font-normal text-[color:var(--ink)]">Day {v.day}: {v.hook}</th>
                    <td className="px-4 py-3 text-[color:var(--ink-dim)]">{v.platform}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-[color:var(--ink)]">{n(v.views48h)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-[color:var(--ink)]">{n(v.views7d)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-[color:var(--ink)]">{v.engagementRate}%</td>
                    <td className="px-4 py-3 text-[color:var(--ink-dim)]">{v.flag === "muted" ? "Audio was muted" : v.flag === "claimed" ? "Audio was claimed" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : posted.length === 0 ? (
          <div className="mt-3 rounded-2xl border border-dashed border-[color:var(--card-border)] px-6 py-10 text-center">
            <p className="font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">Nothing posted yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-[color:var(--ink-dim)]">Post a video from your calendar and mark it as posted. Its numbers appear here 48 hours later.</p>
          </div>
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-[color:var(--card-border)] rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)]" aria-label="Posted videos">
            {posted.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
                <span className="min-w-0 truncate text-[color:var(--ink)]">Day {c.day}: {c.hook || c.angle}</span>
                <span className="shrink-0 text-[13px] text-[color:var(--ink-dim)]">Numbers appear 48 hours after posting</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Container>
  );
}

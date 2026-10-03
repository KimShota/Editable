import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { averageCost, brandLedger, readVideoCosts, summarizeCosts, TARGET_USD_PER_VIDEO } from "@backend/brand/costs";
import { getStorage } from "@backend/storage";
import { getActiveBrand } from "../../../lib/activeBrand";
import { getRequestUser } from "../../../lib/auth";
import { brandRepo } from "../../../lib/brandRepo";
import { query } from "../../../lib/db";
import { Container, EmptyState, PageHeader } from "../../../_components/ui";
import { AdminTabs } from "../_components/AdminTabs";

export const metadata: Metadata = { title: "Cost · Katalab" };

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** What each video cost to make, against the $3 target (plan decision 15).
 *  Measured from the production cost logs, never estimated. Founder only. */
export default async function AdminCostPage() {
  const user = (await getRequestUser())!;
  if (!user.isAdmin) notFound();
  const { active } = await getActiveBrand(user);
  if (!active) {
    return (
      <Container>
        <PageHeader title="Cost" />
        <AdminTabs />
        <EmptyState title="No brand yet">Link a brand first (npm run brand:link).</EmptyState>
      </Container>
    );
  }

  const slug = active.slug;
  const plan = await brandRepo.getPlan(slug);
  const videos = [];
  for (const card of [...(plan?.cards ?? [])].sort((a, b) => a.day - b.day)) {
    const entries = await readVideoCosts(getStorage(), slug, card.id);
    if (entries.length > 0) videos.push({ card, breakdown: summarizeCosts(entries) });
  }
  const { average, overTarget } = averageCost(videos.map((v) => v.breakdown.total));
  const ledger = await brandLedger(query, slug);

  return (
    <Container>
      <PageHeader
        kicker={active.name}
        title="Cost"
        subtitle={`Measured per video, against a target of ${usd(TARGET_USD_PER_VIDEO)}.`}
        actions={videos.length > 0 ? <a href={`/api/admin/brands/${slug}/cost`} className="rounded-full border border-[color:var(--card-border)] px-5 py-2.5 font-[family-name:var(--font-display)] text-sm font-bold tracking-wide text-[color:var(--ink)] hover:border-[color:var(--ink)]">Download CSV</a> : undefined}
      />
      <AdminTabs />

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-5">
          <p className="text-sm text-[color:var(--ink-dim)]">Average per video</p>
          <p className="mt-2 font-[family-name:var(--font-display)] text-3xl font-bold tabular-nums text-[color:var(--ink)]" data-testid="average-cost">{average === null ? "No videos yet" : usd(average)}</p>
          {average !== null && <p className={`mt-1 text-[13px] ${overTarget ? "text-[color:var(--st-bad-fg)]" : "text-[color:var(--st-ready-fg)]"}`} data-testid="target-verdict">{overTarget ? `${usd(average - TARGET_USD_PER_VIDEO)} over the target` : `Within the ${usd(TARGET_USD_PER_VIDEO)} target`}</p>}
        </div>
        <div className="rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-5">
          <p className="text-sm text-[color:var(--ink-dim)]">Videos produced</p>
          <p className="mt-2 font-[family-name:var(--font-display)] text-3xl font-bold tabular-nums text-[color:var(--ink)]">{videos.length}</p>
        </div>
        <div className="rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-5">
          <p className="text-sm text-[color:var(--ink-dim)]">Setup and planning</p>
          <p className="mt-2 font-[family-name:var(--font-display)] text-3xl font-bold tabular-nums text-[color:var(--ink)]">{usd(ledger.total)}</p>
          <p className="mt-1 text-[13px] text-[color:var(--ink-dim)]">Not counted in the per-video average</p>
        </div>
      </div>

      <h2 className="mb-3 font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">Each video</h2>
      {videos.length === 0 ? (
        <EmptyState title="No videos have been produced yet">Their cost appears here, call by call, once a video is made.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Cost per video">
          {videos.map(({ card, breakdown }) => (
            <li key={card.id} data-card-id={card.id} className="rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)]">
              <details>
                <summary className="flex cursor-pointer items-center justify-between gap-4 px-5 py-4 marker:content-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--accent)]">
                  <span className="min-w-0 truncate text-[15px] text-[color:var(--ink)]">Day {card.day}: {card.hook || card.angle}</span>
                  <span className={`shrink-0 font-[family-name:var(--font-display)] text-base font-semibold tabular-nums ${breakdown.total > TARGET_USD_PER_VIDEO ? "text-[color:var(--st-bad-fg)]" : "text-[color:var(--ink)]"}`} data-testid="video-total">{usd(breakdown.total)}</span>
                </summary>
                <table className="w-full border-t border-[color:var(--card-border)] text-left text-sm">
                  <caption className="sr-only">Paid calls for day {card.day}</caption>
                  <thead className="text-[13px] text-[color:var(--ink-dim)]"><tr><th scope="col" className="px-5 py-2 font-medium">Provider</th><th scope="col" className="px-5 py-2 font-medium">What</th><th scope="col" className="px-5 py-2 text-right font-medium">Calls</th><th scope="col" className="px-5 py-2 text-right font-medium">Cost</th></tr></thead>
                  <tbody>
                    {breakdown.lines.map((l) => (
                      <tr key={`${l.provider}-${l.operation}`} className="border-t border-[color:var(--card-border)]">
                        <td className="px-5 py-2 text-[color:var(--ink)]">{l.provider}</td>
                        <td className="px-5 py-2 text-[color:var(--ink-dim)]">{l.operation}</td>
                        <td className="px-5 py-2 text-right tabular-nums text-[color:var(--ink-dim)]">{l.calls}</td>
                        <td className="px-5 py-2 text-right tabular-nums text-[color:var(--ink)]">{usd(l.usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </li>
          ))}
        </ul>
      )}

      {ledger.lines.length > 0 && (
        <>
          <h2 className="mt-10 mb-3 font-[family-name:var(--font-display)] text-base font-semibold text-[color:var(--ink)]">Setup and planning</h2>
          <div className="overflow-x-auto rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)]">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Spend outside any one video</caption>
              <thead className="text-[13px] text-[color:var(--ink-dim)]"><tr><th scope="col" className="px-5 py-2 font-medium">Provider</th><th scope="col" className="px-5 py-2 font-medium">What</th><th scope="col" className="px-5 py-2 text-right font-medium">Calls</th><th scope="col" className="px-5 py-2 text-right font-medium">Cost</th></tr></thead>
              <tbody>
                {ledger.lines.map((l) => (
                  <tr key={`${l.provider}-${l.operation}`} className="border-t border-[color:var(--card-border)]">
                    <td className="px-5 py-2 text-[color:var(--ink)]">{l.provider}</td>
                    <td className="px-5 py-2 text-[color:var(--ink-dim)]">{l.operation}</td>
                    <td className="px-5 py-2 text-right tabular-nums text-[color:var(--ink-dim)]">{l.calls}</td>
                    <td className="px-5 py-2 text-right tabular-nums text-[color:var(--ink)]">{usd(l.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Container>
  );
}

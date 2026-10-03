import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getActiveBrand } from "../../../lib/activeBrand";
import { getRequestUser } from "../../../lib/auth";
import { brandRepo } from "../../../lib/brandRepo";
import { mediaUrl } from "../../../lib/mediaUrl";
import { queue } from "../../../lib/tasks";
import { Container, EmptyState, PageHeader } from "../../../_components/ui";
import { TaskProgress } from "../../../_components/TaskProgress";
import { AddSourceForm } from "../../plan/_components/AddSourceForm";
import { LiveRefresh } from "../../plan/_components/LiveRefresh";

export const metadata: Metadata = { title: "Viral videos · Katalab" };

const compact = (n: number | null): string => (n === null ? "unknown" : new Intl.NumberFormat("en", { notation: "compact" }).format(n));

/** The founder's view of a brand's pool of viral videos: what is in it, how
 *  each one is built, and which plan cards use it. Admin only (the proxy
 *  already hides /admin from everyone else). */
export default async function AdminSourcesPage() {
  const user = (await getRequestUser())!;
  if (!user.isAdmin) notFound();
  const { active } = await getActiveBrand(user);
  if (!active) {
    return (
      <Container>
        <PageHeader title="Viral videos" />
        <EmptyState title="No brand yet">Link a brand first (npm run brand:link).</EmptyState>
      </Container>
    );
  }

  const slug = active.slug;
  const [sources, plan, live] = await Promise.all([brandRepo.listSources(slug), brandRepo.getPlan(slug), queue.listTasks({ slug, kinds: ["source.ingest"] })]);
  const specs = new Map(await Promise.all(sources.filter((s) => s.hasSpec).map(async (s) => [s.sourceId, await brandRepo.getSpec(slug, s.sourceId)] as const)));
  const usedBy = (sourceId: string) => (plan?.cards ?? []).filter((c) => c.sourceId === sourceId).map((c) => c.day).sort((a, b) => a - b);

  return (
    <Container>
      <LiveRefresh active={live.length > 0} />
      <PageHeader kicker={active.name} title="Viral videos" subtitle={`${sources.length} in the pool. Each one is a format your character can recreate.`} />

      {live.length > 0 && (
        <div className="mb-8 flex flex-col gap-3">
          {live.map((t) => (
            <TaskProgress key={t.id} taskId={t.id} title="Adding a viral video" />
          ))}
        </div>
      )}

      <div className="mb-10">
        <AddSourceForm slug={slug} />
      </div>

      {sources.length === 0 ? (
        <EmptyState title="The pool is empty">Add a link above. The plan is built from these videos.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-4" aria-label="Viral videos">
          {sources.map((s) => {
            const spec = specs.get(s.sourceId) ?? null;
            const days = usedBy(s.sourceId);
            return (
              <li key={s.sourceId} data-source-id={s.sourceId} className="rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)]">
                <details className="group">
                  <summary className="grid cursor-pointer grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 p-4 marker:content-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)] md:grid-cols-[auto_1fr_auto]">
                    {s.thumbKey ? (
                      <img src={mediaUrl(s.thumbKey)} alt="" className="row-span-2 h-[4.5rem] w-12 rounded-lg bg-[color:var(--bg-2)] object-cover md:row-span-1" />
                    ) : (
                      <div aria-hidden="true" className="row-span-2 h-[4.5rem] w-12 rounded-lg bg-[color:var(--bg-2)] md:row-span-1" />
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-[15px] font-medium text-[color:var(--ink)]">{spec?.topic ?? (s.hasSpec ? s.sourceId : "Not analysed yet")}</p>
                      <p className="truncate text-sm text-[color:var(--ink-dim)]">
                        {s.creator ?? "Unknown creator"}, {compact(s.views)} views{s.durationSec ? `, ${Math.round(s.durationSec)} seconds` : ""}
                        {s.shotCount ? `, ${s.shotCount} shots` : ""}
                      </p>
                    </div>
                    <p className="col-span-2 text-[13px] text-[color:var(--ink-dim)] md:col-span-1 md:text-right">{days.length > 0 ? `Used on day ${days.join(", ")}` : "Not in the plan"}</p>
                  </summary>

                  <div className="border-t border-[color:var(--card-border)] p-4 text-[15px]">
                    {!spec ? (
                      <p className="text-[color:var(--ink-dim)]">This video has been downloaded but not analysed yet.</p>
                    ) : (
                      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                        <div className="flex flex-col gap-4">
                          <div>
                            <h3 className="font-[family-name:var(--font-display)] text-sm font-semibold text-[color:var(--ink)]">Why it works</h3>
                            <p className="mt-1 leading-relaxed text-[color:var(--ink-dim)]">{spec.whyItWorks}</p>
                          </div>
                          <div>
                            <h3 className="font-[family-name:var(--font-display)] text-sm font-semibold text-[color:var(--ink)]">Opening</h3>
                            <p className="mt-1 leading-relaxed text-[color:var(--ink-dim)]">{spec.hook}</p>
                          </div>
                          <p className="text-sm text-[color:var(--ink-dim)]">
                            {spec.soundDependent ? "Relies on a trending sound." : "Carried by its own voice."} Captions: {spec.captionStyle.mode.replace(/_/g, " ")}, {spec.captionStyle.position}.
                          </p>
                          {s.url && (
                            <a href={s.url} target="_blank" rel="noreferrer noopener" className="text-sm font-medium text-[color:var(--accent)] underline-offset-4 hover:underline">
                              Open the original
                            </a>
                          )}
                        </div>
                        <div>
                          <h3 className="font-[family-name:var(--font-display)] text-sm font-semibold text-[color:var(--ink)]">Shots</h3>
                          <ol className="mt-2 flex flex-col gap-1.5 text-sm">
                            {spec.shots.map((sh) => (
                              <li key={sh.id} className="grid grid-cols-[2.5rem_5rem_1fr] gap-2">
                                <span className="font-medium text-[color:var(--ink)]">{sh.id}</span>
                                <span className="text-[color:var(--ink-dim)]">{sh.kind.replace(/_/g, " ")}</span>
                                <span className="text-[color:var(--ink-dim)]">{sh.subject}</span>
                              </li>
                            ))}
                          </ol>
                        </div>
                      </div>
                    )}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </Container>
  );
}

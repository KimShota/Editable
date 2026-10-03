import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { listPendingInvites } from "@backend/brand/members";
import { CARD_STATUSES } from "@backend/plan/schemas";
import { formatDate } from "@backend/plan/dates";
import { getRequestUser } from "../../../lib/auth";
import { brandRepo } from "../../../lib/brandRepo";
import { query } from "../../../lib/db";
import { Container, EmptyState, PageHeader } from "../../../_components/ui";
import { AdminTabs } from "../_components/AdminTabs";
import { BrandAdminActions } from "../_components/BrandAdminActions";

export const metadata: Metadata = { title: "Brands · Katalab" };

const LABEL: Record<string, string> = {
  draft: "Draft",
  approved: "Approved",
  queued: "Queued",
  generating: "Generating",
  internal_review: "In review",
  needs_review: "With customer",
  ready: "Ready",
  posted: "Posted",
  skipped: "Skipped",
  failed: "Failed",
};

/** Every brand, who is in its workspace, and where its cycle stands. Founder only. */
export default async function AdminBrandsPage() {
  const user = (await getRequestUser())!;
  if (!user.isAdmin) notFound();
  const brands = await brandRepo.listBrandsForUser(user);

  const rows = await Promise.all(
    brands.map(async (b) => {
      const [plan, members, workspace] = await Promise.all([brandRepo.getPlan(b.slug), brandRepo.listMembers(b.slug), brandRepo.getWorkspace(b.slug)]);
      const pending = await listPendingInvites(query, workspace.id);
      const counts = new Map<string, number>();
      for (const c of plan?.cards ?? []) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
      return { b, plan, members, workspace, pending, counts };
    }),
  );

  return (
    <Container>
      <PageHeader title="Brands" subtitle="Who is in each workspace, and where each cycle stands." />
      <AdminTabs />
      {rows.length === 0 ? (
        <EmptyState title="No brands yet">Link a brand first (npm run brand:link).</EmptyState>
      ) : (
        <ul className="flex flex-col gap-6" aria-label="Brands">
          {rows.map(({ b, plan, members, workspace, pending, counts }) => (
            <li key={b.slug} data-brand={b.slug} className="rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-6">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold text-[color:var(--ink)]">{b.name}</h2>
                <p className="text-sm text-[color:var(--ink-dim)]">{b.slug}, workspace {workspace.name}</p>
              </div>

              <div className="mt-4 grid gap-6 lg:grid-cols-2">
                <div>
                  <h3 className="text-sm font-medium text-[color:var(--ink)]">Cycle</h3>
                  {plan ? (
                    <>
                      <p className="mt-1 text-sm text-[color:var(--ink-dim)]">
                        {plan.cycleId} from {formatDate(plan.startsOn, { weekday: true })}, {plan.cards.length} video{plan.cards.length === 1 ? "" : "s"}
                        {plan.niche ? `, angle: ${plan.niche.title}` : ", no angle yet"}
                      </p>
                      <ul className="mt-3 flex flex-wrap gap-2" aria-label={`${b.name} videos by status`}>
                        {CARD_STATUSES.filter((s) => counts.get(s)).map((s) => (
                          <li key={s} className="rounded-full bg-[color:var(--bg-2)] px-3 py-1 text-[13px] text-[color:var(--ink)]">{LABEL[s]}: {counts.get(s)}</li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="mt-1 text-sm text-[color:var(--ink-dim)]">No plan yet.</p>
                  )}
                  <h3 className="mt-5 text-sm font-medium text-[color:var(--ink)]">Members</h3>
                  <ul className="mt-1 flex flex-col gap-1 text-sm text-[color:var(--ink-dim)]" aria-label={`${b.name} members`}>
                    {members.length === 0 ? <li>No one yet.</li> : members.map((m) => <li key={m.userId}>{m.email}</li>)}
                  </ul>
                </div>
                <BrandAdminActions slug={b.slug} brandName={b.name} pending={pending.map((p) => p.email)} canAnnounce={(plan?.cards.length ?? 0) > 0} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Container>
  );
}

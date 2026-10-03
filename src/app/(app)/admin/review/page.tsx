import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { dateOfDay, formatDate } from "@backend/plan/dates";
import { getActiveBrand } from "../../../lib/activeBrand";
import { getRequestUser } from "../../../lib/auth";
import { brandRepo } from "../../../lib/brandRepo";
import { mediaUrl } from "../../../lib/mediaUrl";
import { Container, EmptyState, PageHeader, StatusBadge } from "../../../_components/ui";
import { AdminTabs } from "../_components/AdminTabs";
import { SendButton } from "../_components/ProductionActions";

export const metadata: Metadata = { title: "Review · Katalab" };

const REASON: Record<string, string> = {
  character_off: "The character looks off",
  product_wrong: "The product is wrong",
  weird_motion: "The motion looks strange",
  audio: "The audio",
  other: "Something else",
};

/** The review gate: finished videos wait here until the founder has watched
 *  them. Nothing is visible to the customer before "Send to customer". */
export default async function AdminReviewPage() {
  const user = (await getRequestUser())!;
  if (!user.isAdmin) notFound();
  const { active } = await getActiveBrand(user);
  if (!active) {
    return (
      <Container>
        <PageHeader title="Review" />
        <AdminTabs />
        <EmptyState title="No brand yet">Link a brand first (npm run brand:link).</EmptyState>
      </Container>
    );
  }

  const slug = active.slug;
  const plan = await brandRepo.getPlan(slug);
  const waiting = [...(plan?.cards ?? [])].filter((c) => c.status === "internal_review").sort((a, b) => a.day - b.day);
  const videos = new Map(await Promise.all(waiting.map(async (c) => [c.id, await brandRepo.getVideo(slug, c.id)] as const)));

  return (
    <Container>
      <PageHeader
        kicker={active.name}
        title="Review"
        subtitle={waiting.length ? `${waiting.length} finished video${waiting.length === 1 ? "" : "s"} waiting. The customer cannot see them yet.` : "Nothing is waiting for review."}
        actions={waiting.length > 1 ? <SendButton slug={slug} cardIds={waiting.map((c) => c.id)} label={`Send all ${waiting.length} to customer`} /> : undefined}
      />
      <AdminTabs />

      {waiting.length === 0 ? (
        <EmptyState title="The gate is clear">Finished videos appear here before the customer sees them.</EmptyState>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2" aria-label="Videos awaiting review">
          {waiting.map((card) => {
            const video = videos.get(card.id)!;
            return (
              <li key={card.id} data-card-id={card.id} className="grid grid-cols-[8rem_1fr] gap-4 rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-4">
                {video.finalKey ? (
                  <video src={mediaUrl(video.finalKey)} controls playsInline preload="metadata" aria-label={`Day ${card.day} video`} className="aspect-[9/16] w-full rounded-xl bg-[color:var(--ink)] object-contain" />
                ) : (
                  <div className="flex aspect-[9/16] w-full items-center justify-center rounded-xl bg-[color:var(--bg-2)] px-2 text-center text-xs text-[color:var(--ink-dim)]">No video file</div>
                )}
                <div className="flex min-w-0 flex-col gap-3">
                  <div>
                    <p className="font-[family-name:var(--font-display)] text-sm font-semibold text-[color:var(--ink)]">
                      Day {card.day}, {plan ? formatDate(dateOfDay(plan.startsOn, card.day), { weekday: true }) : ""}
                    </p>
                    <p className="mt-1 line-clamp-3 text-[15px] text-[color:var(--ink)]">{card.angle}</p>
                  </div>
                  <StatusBadge status={card.status} lowConfidence={card.lowConfidence} audience="admin" />
                  {card.lowConfidence && <p className="text-[13px] text-[color:var(--st-warn)]">A clip only passed its checks on the last retry. Look closely before sending.</p>}
                  {card.thumbsDown && (
                    <p data-testid="not-right" className="rounded-lg bg-[color:var(--st-bad-bg)] px-3 py-2 text-[13px] text-[color:var(--st-bad-fg)]">
                      Sent back: {REASON[card.thumbsDown.reason] ?? card.thumbsDown.reason}
                      {card.thumbsDown.note ? `. "${card.thumbsDown.note}"` : ""}
                    </p>
                  )}
                  <p className="text-[13px] text-[color:var(--ink-dim)]">Cost so far ${video.costUsd.toFixed(2)}</p>
                  <div className="mt-auto flex flex-wrap items-center gap-3">
                    <SendButton slug={slug} cardIds={[card.id]} label="Send to customer" />
                    <Link href={`/videos/${card.id}/edit`} className="text-sm font-medium text-[color:var(--accent)] underline-offset-4 hover:underline">
                      Open in editor
                    </Link>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Container>
  );
}

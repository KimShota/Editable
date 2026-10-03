import type { Metadata } from "next";
import Link from "next/link";
import { cardHref, layoutCycle, summarizeCycle } from "@backend/plan/calendar";
import { formatDate, todayIn } from "@backend/plan/dates";
import type { Card } from "@backend/plan/schemas";
import { isVideoVisible } from "@backend/plan/status";
import { getActiveBrand } from "../../lib/activeBrand";
import { getRequestUser } from "../../lib/auth";
import { brandRepo } from "../../lib/brandRepo";
import { now } from "../../lib/clock";
import { mediaUrl } from "../../lib/mediaUrl";
import { Container, EmptyState, PageHeader, StatusBadge } from "../../_components/ui";
import { ApproveVideos, type WaitingVideo } from "./_components/ApproveVideos";
import { AutoPostBanner } from "./_components/AutoPostBanner";
import { ManualPostActions } from "./_components/ManualPostActions";

export const metadata: Metadata = { title: "Calendar · Katalab" };

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type Thumb = { kind: "video" | "image"; url: string } | null;
type CellData = { card: Card; href: string; hasVideo: boolean; thumb: Thumb; post: { downloadUrl: string; copyText: string; postedUrl: string | null } | null };

/**
 * Home: the cycle on a Monday-to-Sunday grid (plan/ui-ux-full-flow.md §6).
 * Each day shows what is there to look at (the video's first frame, else the
 * storyboard, else a frame of the original), its status, and where clicking
 * leads. Ready videos carry the manual-posting actions.
 */
export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const sentBack = (await searchParams)["sent-back"] === "1";
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

  const slug = active.slug;
  const [plan, brand] = await Promise.all([brandRepo.getPlan(slug), brandRepo.getBrand(slug)]);
  if (!plan) {
    return (
      <Container>
        <PageHeader kicker={active.name} title="Calendar" />
        <EmptyState title="Your plan is being built">Your first 14 days of videos will appear here.</EmptyState>
      </Container>
    );
  }

  const today = todayIn(brand.timezone, now());
  const weeks = layoutCycle(plan, today);
  const summary = summarizeCycle(plan, today);

  // What each card shows. A video is only used if this viewer may see it.
  const data = new Map<string, CellData>();
  await Promise.all(
    plan.cards.map(async (card) => {
      const visible = isVideoVisible(card.status, user.isAdmin);
      const [video, stills, spec, details, script] = await Promise.all([
        visible ? brandRepo.getVideo(slug, card.id) : null,
        brandRepo.listStoryboard(slug, card.id),
        brandRepo.getSpec(slug, card.sourceId),
        card.status === "ready" || card.status === "posted" ? brandRepo.getPostDetails(slug, card.id) : null,
        card.status === "ready" ? brandRepo.getScript(slug, card.id) : null,
      ]);
      const hasVideo = Boolean(video?.hasEdl);
      const keyframe = spec?.shots[0]?.keyframes[0]?.key;
      const thumb: Thumb =
        video?.finalKey ? { kind: "video", url: `${mediaUrl(video.finalKey)}#t=0.5` } : stills[0] ? { kind: "image", url: mediaUrl(stills[0].key) } : keyframe ? { kind: "image", url: mediaUrl(keyframe) } : null;
      const caption = details?.caption || script?.postCaption || "";
      const tags = (details?.hashtags.length ? details.hashtags : (script?.hashtags ?? [])).map((h) => `#${h}`).join(" ");
      data.set(card.id, {
        card,
        href: cardHref(card.id, hasVideo),
        hasVideo,
        thumb,
        post: card.status === "ready" && video?.finalKey ? { downloadUrl: mediaUrl(video.finalKey), copyText: [caption.trim(), tags].filter(Boolean).join("\n\n"), postedUrl: null } : card.status === "posted" ? { downloadUrl: "", copyText: "", postedUrl: details?.postedUrls[0] ?? null } : null,
      });
    }),
  );

  const waiting: WaitingVideo[] = plan.cards
    .filter((c) => c.status === "needs_review")
    .sort((a, b) => a.day - b.day)
    .map((c) => ({ id: c.id, day: c.day, dateLabel: formatDate(weeks.flat().find((x) => x.kind === "day" && x.day === c.day)!.date), hook: c.hook || c.angle, flagged: c.lowConfidence }));

  const pct = Math.round((summary.ready / summary.total) * 100);

  return (
    <Container>
      <PageHeader
        kicker={active.name}
        title="Calendar"
        subtitle={`Cycle ${plan.cycleId}, ${formatDate(summary.startsOn)} to ${formatDate(summary.endsOn)}`}
        actions={<ApproveVideos slug={slug} waiting={waiting} />}
      />

      <div className="mb-8">
        <div className="flex items-baseline justify-between gap-4 text-sm">
          <p className="font-[family-name:var(--font-display)] font-semibold text-[color:var(--ink)]" data-testid="cycle-progress-label">
            {summary.ready} of {summary.total} ready
          </p>
          <p className="text-[color:var(--ink-dim)]" data-testid="cycle-countdown">
            {summary.countdown}
          </p>
        </div>
        <div role="progressbar" aria-label="Videos ready this cycle" aria-valuemin={0} aria-valuemax={summary.total} aria-valuenow={summary.ready} className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--bg-2)]">
          <div className="h-full rounded-full bg-[color:var(--ink)] transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <AutoPostBanner />
      {sentBack && (
        <p role="status" className="mb-6 rounded-xl bg-[color:var(--st-queued-bg)] px-4 py-3 text-sm text-[color:var(--st-queued-fg)]">
          Thank you. We will look at that video and send you a new version.
        </p>
      )}

      <div aria-hidden="true" className="mb-2 hidden grid-cols-7 gap-2 text-xs font-semibold tracking-wide text-[color:var(--ink-dim)] uppercase md:grid">
        {WEEKDAYS.map((d) => (
          <span key={d} className="px-1">
            {d}
          </span>
        ))}
      </div>

      <ol aria-label="Your videos by day" className="flex flex-col gap-3 md:grid md:grid-cols-7 md:gap-2">
        {weeks.flat().map((cell) => {
          if (cell.kind === "outside") return <li key={cell.date} aria-hidden="true" className="hidden rounded-2xl bg-[color:var(--bg-2)]/60 md:block" />;
          const d = data.get(cell.card?.id ?? "");
          const label = formatDate(cell.date, { weekday: true });
          const ring = cell.today ? "ring-2 ring-[color:var(--accent)] ring-offset-2 ring-offset-[color:var(--bg)] max-md:order-first" : "";

          if (!cell.card || !d) {
            return (
              <li key={cell.date} data-day={cell.day} className={`flex min-h-24 flex-col justify-between rounded-2xl border border-dashed border-[color:var(--card-border)] p-3 ${ring}`}>
                <div>
                  <p className="flex items-baseline justify-between gap-2 text-sm font-semibold text-[color:var(--ink)]">
                    Day {cell.day}
                    {cell.today && <span className="text-xs font-medium text-[color:var(--accent)]">Today</span>}
                  </p>
                  <p className="text-[13px] text-[color:var(--ink-dim)]">{label}</p>
                </div>
                <p className="text-[13px] text-[color:var(--ink-dim)]">Nothing planned yet</p>
              </li>
            );
          }

          return (
            <li key={cell.date} data-day={cell.day} data-card-id={d.card.id} className={`flex flex-col gap-3 rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-3 ${cell.past && d.card.status === "draft" ? "opacity-70" : ""} ${ring}`}>
              <Link href={d.href} className="flex gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)] md:flex-col">
                <div className="aspect-[3/4] w-16 shrink-0 overflow-hidden rounded-lg bg-[color:var(--bg-2)] md:w-full">
                  {d.thumb?.kind === "video" ? (
                    <video src={d.thumb.url} muted playsInline preload="metadata" tabIndex={-1} aria-hidden="true" className="h-full w-full object-cover" />
                  ) : d.thumb ? (
                    <img src={d.thumb.url} alt="" className="h-full w-full object-cover" />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex items-baseline justify-between gap-2 text-sm font-semibold text-[color:var(--ink)]">
                    Day {cell.day}
                    {cell.today && <span className="text-xs font-medium text-[color:var(--accent)]">Today</span>}
                  </p>
                  <p className="text-[13px] text-[color:var(--ink-dim)]">{label}</p>
                  <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-[color:var(--ink-dim)]">{d.card.hook || d.card.angle}</p>
                  <div className="mt-2">
                    <StatusBadge status={d.card.status} lowConfidence={d.card.lowConfidence} audience="customer" />
                  </div>
                </div>
              </Link>
              {d.post?.downloadUrl && <ManualPostActions slug={slug} cardId={d.card.id} dayLabel={`day ${cell.day}`} downloadUrl={d.post.downloadUrl} copyText={d.post.copyText} />}
              {d.post?.postedUrl && (
                <a href={d.post.postedUrl} target="_blank" rel="noreferrer noopener" className="text-xs font-medium text-[color:var(--accent)] underline-offset-4 hover:underline">
                  View the post
                </a>
              )}
            </li>
          );
        })}
      </ol>
    </Container>
  );
}

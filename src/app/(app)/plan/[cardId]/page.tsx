import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { recreationKeys } from "@backend/brand/keys";
import { dateOfDay, formatDate } from "@backend/plan/dates";
import { isVideoVisible } from "@backend/plan/status";
import { getActiveBrand } from "../../../lib/activeBrand";
import { getRequestUser } from "../../../lib/auth";
import { editorPath } from "../../../lib/autoOpenEditor";
import { brandRepo } from "../../../lib/brandRepo";
import { mediaUrl } from "../../../lib/mediaUrl";
import { queue } from "../../../lib/tasks";
import { Container, EmptyState } from "../../../_components/ui";
import { LiveRefresh } from "../_components/LiveRefresh";
import { CardWorkspace, type Row, type Shot } from "./_components/CardWorkspace";

export const metadata: Metadata = { title: "Plan · Katalab" };

export default async function CardPage({ params }: { params: Promise<{ cardId: string }> }) {
  const { cardId } = await params;
  const user = (await getRequestUser())!;
  const { active } = await getActiveBrand(user);
  if (!active) notFound();
  const slug = active.slug;

  const [plan, card] = await Promise.all([brandRepo.getPlan(slug), brandRepo.getCard(slug, cardId)]);
  if (!plan || !card) notFound();

  const [script, spec, stills, sources, live, madeVideo] = await Promise.all([
    brandRepo.getScript(slug, cardId),
    brandRepo.getSpec(slug, card.sourceId),
    brandRepo.listStoryboard(slug, cardId),
    brandRepo.listSources(slug),
    queue.listTasks({ slug, cardId, kinds: ["card.adapt", "card.storyboard", "video.produce"] }),
    // The video we made, only for someone who may see it (the founder from internal review, a customer once it is sent).
    isVideoVisible(card.status, user.isAdmin) ? brandRepo.getVideo(slug, cardId) : null,
  ]);

  const k = recreationKeys(slug);
  const stillOf = new Map(stills.map((s) => [s.shotId, s.key]));
  const rows: Row[] = (script?.lines ?? []).map((l) => ({
    index: l.index,
    role: l.role,
    startSec: spec?.speech.lines[l.index]?.startSec ?? 0,
    sourceText: l.sourceText,
    text: l.text,
    sourceWords: l.sourceWordCount,
  }));
  const shots: Shot[] = (script?.shots ?? []).map((s) => {
    const still = stillOf.get(s.shotId);
    const frame = spec?.shots.find((x) => x.id === s.shotId)?.keyframes[0]?.key;
    const key = still ?? frame ?? null;
    return { id: s.shotId, treatment: s.treatment, action: s.action, image: key ? mediaUrl(key) : null, imageIsStoryboard: Boolean(still) };
  });

  const hasVideo = sources.some((s) => s.sourceId === card.sourceId);
  const swapOptions = sources
    .filter((s) => s.hasSpec && s.sourceId !== card.sourceId)
    .map((s) => ({ sourceId: s.sourceId, label: `${(s.hook ?? s.sourceId).slice(0, 70)}${s.creator ? ` (${s.creator})` : ""}` }));

  const ordered = [...plan.cards].sort((a, b) => a.day - b.day);
  const at = ordered.findIndex((c) => c.id === cardId);

  // While the video is being made the page re-reads itself, so a run that starts after it was
  // opened shows its progress, and the finished video replaces it without a reload.
  const making = card.status === "queued" || card.status === "generating";

  return (
    <Container>
      <LiveRefresh active={making || live.length > 0} />
      <nav aria-label="Breadcrumb" className="mb-6 flex items-center justify-between gap-4 text-sm">
        <Link href="/plan" className="font-medium text-[color:var(--ink-dim)] underline-offset-4 hover:text-[color:var(--ink)] hover:underline">
          All videos
        </Link>
        <span className="flex items-center gap-4">
          {ordered[at - 1] && (
            <Link href={`/plan/${ordered[at - 1].id}`} className="font-medium text-[color:var(--ink-dim)] hover:text-[color:var(--ink)]" aria-label={`Previous: day ${ordered[at - 1].day}`}>
              Previous day
            </Link>
          )}
          {ordered[at + 1] && (
            <Link href={`/plan/${ordered[at + 1].id}`} className="font-medium text-[color:var(--ink-dim)] hover:text-[color:var(--ink)]" aria-label={`Next: day ${ordered[at + 1].day}`}>
              Next day
            </Link>
          )}
        </span>
      </nav>

      <header className="mb-8">
        <p className="font-[family-name:var(--font-display)] text-[12px] tracking-[0.3em] text-[color:var(--accent)] uppercase">{formatDate(dateOfDay(plan.startsOn, card.day), { weekday: true })}</p>
        <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight text-[color:var(--ink)] sm:text-4xl">Day {card.day}</h1>
        <p className="mt-3 max-w-[65ch] text-lg text-[color:var(--ink)]">{card.angle}</p>
      </header>

      {!script && live.length === 0 && !spec ? (
        <EmptyState title="This video is not ready to review">Its original is still being prepared. Check back in a moment.</EmptyState>
      ) : (
        <CardWorkspace
          slug={slug}
          cardId={card.id}
          dayLabel={`Day ${card.day}`}
          status={card.status}
          audience={user.isAdmin ? "admin" : "customer"}
          editorPath={editorPath(card.id)}
          canOpenEditor={Boolean(madeVideo?.hasEdl)}
          lowConfidence={card.lowConfidence}
          angle={card.angle}
          whyItWorks={spec?.whyItWorks ?? null}
          videoUrl={hasVideo ? mediaUrl(k.video(card.sourceId)) : null}
          rows={rows}
          shots={shots}
          swapOptions={swapOptions}
          liveTasks={live.map((t) => ({ id: t.id, kind: t.kind }))}
          prevId={ordered[at - 1]?.id ?? null}
          nextId={ordered[at + 1]?.id ?? null}
        />
      )}
    </Container>
  );
}

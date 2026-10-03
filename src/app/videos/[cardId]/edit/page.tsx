import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { recreationKeys, videoJobId } from "@backend/brand/keys";
import { dateOfDay, formatDate } from "@backend/plan/dates";
import { isVideoVisible } from "@backend/plan/status";
import { repoRoot } from "@backend/pipeline/paths";
import { storageRoot } from "@backend/storage";
import { getActiveBrand } from "../../../lib/activeBrand";
import { getRequestUser } from "../../../lib/auth";
import { brandRepo } from "../../../lib/brandRepo";
import { loadEditorData } from "../../../lib/editorData";
import { mediaUrl } from "../../../lib/mediaUrl";
import { Editor } from "../../../jobs/[jobId]/edit/_components/Editor";
import { VideoShell } from "./_components/VideoShell";

export const metadata: Metadata = { title: "Video · Katalab" };

/**
 * A brand's finished video in the editor (plan/ui-ux-full-flow.md §5). A card
 * id is a source id, so the same id can exist in two brands: the active brand
 * is preferred, then any other the user may open that has this card. A
 * customer reaches only videos that have passed the founder's review gate;
 * for anything else this page does not exist.
 */
export default async function VideoEditPage({ params }: { params: Promise<{ cardId: string }> }) {
  const { cardId } = await params;
  const user = await getRequestUser();
  if (!user) redirect("/login");

  const { active, all } = await getActiveBrand(user);
  const candidates = [...(active ? [active] : []), ...all.filter((b) => b.slug !== active?.slug)];
  let slug: string | null = null;
  for (const b of candidates) {
    if (await brandRepo.getCard(b.slug, cardId)) {
      slug = b.slug;
      break;
    }
  }
  if (!slug) notFound();

  const [plan, card, brand] = await Promise.all([brandRepo.getPlan(slug), brandRepo.getCard(slug, cardId), brandRepo.getBrand(slug)]);
  if (!plan || !card || !isVideoVisible(card.status, user.isAdmin)) notFound();

  const jobId = videoJobId(slug, cardId);
  const data = await loadEditorData(jobId);
  if (!data) notFound(); // not produced yet

  const [spec, script, details, video] = await Promise.all([
    brandRepo.getSpec(slug, card.sourceId),
    brandRepo.getScript(slug, cardId),
    brandRepo.getPostDetails(slug, cardId),
    brandRepo.getVideo(slug, cardId),
  ]);

  const k = recreationKeys(slug);
  const source = spec ? { videoUrl: mediaUrl(k.video(card.sourceId)), shots: Object.fromEntries(spec.shots.map((s) => [s.id, { startSec: s.startSec, endSec: s.endSec }])) } : null;

  // What to download: an export made in the editor if it is newer than the
  // produced video, else the produced video itself.
  const exported = path.join(repoRoot, "out", `${jobId}.mp4`);
  const finalFile = video.finalKey ? path.join(storageRoot(), video.finalKey) : null;
  const useExport = fs.existsSync(exported) && (!finalFile || !fs.existsSync(finalFile) || fs.statSync(exported).mtimeMs > fs.statSync(finalFile).mtimeMs);
  const downloadUrl = useExport ? `/api/media/out/${jobId}.mp4` : video.finalKey ? mediaUrl(video.finalKey) : "";

  return (
    <VideoShell
      slug={slug}
      cardId={cardId}
      dayLabel={`Day ${card.day}`}
      angle={card.angle}
      status={card.status}
      lowConfidence={card.lowConfidence}
      isAdmin={user.isAdmin}
      source={source}
      post={{
        caption: details.caption || script?.postCaption || "",
        hashtags: details.hashtags.length > 0 ? details.hashtags : (script?.hashtags ?? []),
        platforms: details.platforms,
        postedUrls: details.postedUrls,
      }}
      plannedLabel={`${formatDate(dateOfDay(plan.startsOn, card.day), { weekday: true })} at ${brand.postTime}`}
      downloadUrl={downloadUrl}
    >
      <Editor jobId={jobId} formatName={data.formatName} initialEdl={data.edl} aiVideo={data.aiVideo} backHref="/calendar" subtitle={`Day ${card.day}`} />
    </VideoShell>
  );
}

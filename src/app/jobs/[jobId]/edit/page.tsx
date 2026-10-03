import fs from "node:fs";
import path from "node:path";
import { notFound, redirect } from "next/navigation";
import { jobExists } from "../../../lib/jobs";
import { loadEditorData } from "../../../lib/editorData";
import { brandRepo } from "../../../lib/brandRepo";
import { repoRoot } from "@backend/pipeline/paths";
import { Editor } from "./_components/Editor";

export default async function EditPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) notFound();

  // A brand's AI video lives at /videos/<card>/edit (with its review bar and
  // post panel). This route stays for the old template videos, and sends a
  // brand video there when it is in a plan.
  const marker = path.join(repoRoot, "jobs", jobId, "ai-video.json");
  if (fs.existsSync(marker)) {
    const meta = JSON.parse(fs.readFileSync(marker, "utf8")) as { brand?: string; card?: string; source?: string };
    const cardId = meta.card ?? meta.source;
    if (meta.brand && cardId && (await brandRepo.getCard(meta.brand, cardId).catch(() => null))) redirect(`/videos/${cardId}/edit`);
  }

  const data = await loadEditorData(jobId);
  if (!data) redirect(`/jobs/${jobId}/resources`);

  return (
    <div className="fixed inset-0 z-10">
      <Editor jobId={jobId} formatName={data.formatName} initialEdl={data.edl} aiVideo={data.aiVideo} />
    </div>
  );
}

import fs from "node:fs";
import path from "node:path";
import { notFound, redirect } from "next/navigation";
import { jobExists, readJobManifest } from "../../../lib/jobs";
import { loadFormat } from "../../../../pipeline/loader";
import { artifactsDir } from "../../../../pipeline/paths";
import { stageAssets } from "../../../../pipeline/render";
import { Edl } from "../../../../pipeline/types";
import { Container, PageHeader } from "../../../_components/ui";
import { Editor } from "./_components/Editor";

export default async function EditPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) notFound();

  const edlPath = path.join(artifactsDir(jobId), "edl.json");
  if (!fs.existsSync(edlPath)) {
    redirect(`/jobs/${jobId}/resources`);
  }

  const manifest = readJobManifest(jobId);
  const format = loadFormat(manifest.format);
  const edl: Edl = JSON.parse(fs.readFileSync(edlPath, "utf8"));
  // Idempotent: makes sure the Player's staticFile() lookups resolve even
  // after a server restart, without waiting for a real render.
  stageAssets(edl);

  return (
    <Container className="max-w-[1500px]">
      <PageHeader kicker={format.name} title="Editor" subtitle="Nudge timing, swap transitions, then render." />
      <Editor jobId={jobId} format={format} initialEdl={edl} />
    </Container>
  );
}

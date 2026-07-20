import fs from "node:fs";
import path from "node:path";
import { notFound, redirect } from "next/navigation";
import { jobExists, jobDir, readJobManifest } from "../../../lib/jobs";
import { loadFormat } from "@backend/pipeline/loader";
import { artifactsDir } from "@backend/pipeline/paths";
import { stageAssets } from "@backend/pipeline/render";
import { readOrMigrateEdl } from "@backend/pipeline/orchestrate";
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
  // Migration-safe: backfills clip ids via one reassemble if this edl.json
  // predates the timeline-ops schema, then edl.json is the source of
  // truth from here on — the editor never re-derives from the format again.
  const edl = readOrMigrateEdl(jobDir(jobId), jobId);
  // Idempotent: makes sure the Player's staticFile() lookups resolve even
  // after a server restart, without waiting for a real render.
  stageAssets(edl);

  return (
    <div className="fixed inset-0 z-10">
      <Editor jobId={jobId} formatName={format.name} initialEdl={edl} />
    </div>
  );
}

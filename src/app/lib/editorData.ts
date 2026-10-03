import "server-only";
import fs from "node:fs";
import path from "node:path";
import { jobDir, jobExists, readJobManifest } from "./jobs";
import { loadFormat } from "@backend/pipeline/loader";
import { AI_VIDEO_FORMAT } from "@backend/production/format";
import { artifactsDir } from "@backend/pipeline/paths";
import { stageAssets } from "@backend/pipeline/render";
import { readOrMigrateEdl } from "@backend/pipeline/orchestrate";
import type { Edl } from "@backend/pipeline/types";

/**
 * What the editor needs to open a job, shared by the old /jobs/<id>/edit
 * route and the new /videos/<card>/edit one. Returns null when there is
 * nothing to edit yet (no job, or no EDL: the video has not been produced).
 */
export type EditorData = { edl: Edl; formatName: string; aiVideo: boolean };

export const loadEditorData = async (jobId: string): Promise<EditorData | null> => {
  if (!jobExists(jobId)) return null;
  if (!fs.existsSync(path.join(artifactsDir(jobId), "edl.json"))) return null;

  const manifest = readJobManifest(jobId);
  const aiVideo = manifest.format === AI_VIDEO_FORMAT;
  // An AI video has no template behind it: its edl.json is the whole video.
  const formatName = aiVideo ? "AI video" : loadFormat(manifest.format).name;
  // Migration-safe: backfills clip ids via one reassemble if this edl.json
  // predates the timeline-ops schema, then edl.json is the source of truth
  // from here on: the editor never re-derives from the format again.
  const edl = await readOrMigrateEdl(jobDir(jobId), jobId);
  // Idempotent: makes sure the Player's staticFile() lookups resolve even
  // after a server restart, without waiting for a real render.
  stageAssets(edl);
  return { edl, formatName, aiVideo };
};

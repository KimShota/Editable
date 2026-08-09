import "server-only";
import fs from "node:fs";
import path from "node:path";
import { artifactsDir, outDir, publicDir } from "@backend/pipeline/paths";
import { jobDir, listJobs, readJobManifest } from "./jobs";

/**
 * The "Projects" dashboard's view over jobs/ — same store as lib/jobs.ts,
 * with the extra bits a home-screen tile needs (a display name, a
 * thumbnail source, disk size, duration, trash) that the CLI pipeline has
 * no reason to know about. Kept in a project.json sidecar beside job.json,
 * the same pattern lib/jobs.ts already uses for script.json/
 * hook-feedback.json: job content the pipeline never reads.
 */

type ProjectSidecar = {
  /** User-set display name. Absent until renamed, matching CapCut's
   *  date-stamped default that only becomes a real filename once touched. */
  name?: string;
  trashedAt?: string;
};

export type ProjectSummary = {
  id: string;
  name: string;
  formatId: string;
  createdAt: string;
  sizeBytes: number;
  durationSec: number | null;
  rendered: boolean;
  /** Whether an EDL exists yet — same signal the resume-target logic
   *  elsewhere in the app (PastJobsList) already keys off of. */
  hasEdl: boolean;
  trashed: boolean;
};

const projectSidecarPath = (jobId: string): string => path.join(jobDir(jobId), "project.json");

const readProjectSidecar = (jobId: string): ProjectSidecar => {
  try {
    return JSON.parse(fs.readFileSync(projectSidecarPath(jobId), "utf8"));
  } catch {
    return {};
  }
};

const writeProjectSidecar = (jobId: string, sidecar: ProjectSidecar): void => {
  fs.writeFileSync(projectSidecarPath(jobId), JSON.stringify(sidecar, null, 2));
};

export const renameProject = (jobId: string, name: string): void => {
  writeProjectSidecar(jobId, { ...readProjectSidecar(jobId), name });
};

export const trashProject = (jobId: string): void => {
  writeProjectSidecar(jobId, { ...readProjectSidecar(jobId), trashedAt: new Date().toISOString() });
};

export const restoreProject = (jobId: string): void => {
  const sidecar = readProjectSidecar(jobId);
  delete sidecar.trashedAt;
  writeProjectSidecar(jobId, sidecar);
};

/** Removes every trace of a job: the draft/assets themselves, derived
 *  pipeline artifacts, anything staged to public/ for the editor, and the
 *  rendered export — mirroring exactly what createJob/getJobStatus in
 *  lib/jobs.ts know how to create. */
export const deleteProjectPermanently = (jobId: string): void => {
  fs.rmSync(jobDir(jobId), { recursive: true, force: true });
  fs.rmSync(artifactsDir(jobId), { recursive: true, force: true });
  fs.rmSync(path.join(publicDir, "jobs", jobId), { recursive: true, force: true });
  fs.rmSync(path.join(outDir, `${jobId}.mp4`), { force: true });
};

const dirSizeBytes = (dir: string): number => {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSizeBytes(full) : entry.isFile() ? fs.statSync(full).size : 0;
  }
  return total;
};

const projectSizeBytes = (jobId: string): number => {
  const outMp4 = path.join(outDir, `${jobId}.mp4`);
  return (
    dirSizeBytes(jobDir(jobId)) +
    dirSizeBytes(artifactsDir(jobId)) +
    dirSizeBytes(path.join(publicDir, "jobs", jobId)) +
    (fs.existsSync(outMp4) ? fs.statSync(outMp4).size : 0)
  );
};

const projectDurationSec = (jobId: string): number | null => {
  const edlPath = path.join(artifactsDir(jobId), "edl.json");
  if (!fs.existsSync(edlPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(edlPath, "utf8"));
    return typeof data.durationSec === "number" ? data.durationSec : null;
  } catch {
    return null;
  }
};

const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".m4v"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const fillPaths = (fill: { file: string } | { files: string[] } | { text: string }): string[] => {
  if ("file" in fill) return [fill.file];
  if ("files" in fill) return fill.files;
  return [];
};

/** What to run a poster frame off of for a project tile: the rendered
 *  export if there is one (truest to what the project actually is now),
 *  else the first bound video, else the first bound image. Null means the
 *  tile has nothing to show yet (a fresh draft with no footage filmed) —
 *  callers fall back to a flat placeholder, same as CapCut does. */
export const findThumbnailSource = (jobId: string): { absPath: string; kind: "video" | "image" } | null => {
  const outMp4 = path.join(outDir, `${jobId}.mp4`);
  if (fs.existsSync(outMp4)) return { absPath: outMp4, kind: "video" };

  let bindings;
  try {
    bindings = readJobManifest(jobId).bindings;
  } catch {
    return null;
  }

  const absPaths = Object.values(bindings)
    .flatMap(fillPaths)
    .map((rel) => path.join(jobDir(jobId), rel))
    .filter((p) => fs.existsSync(p));

  const video = absPaths.find((p) => VIDEO_EXT.has(path.extname(p).toLowerCase()));
  if (video) return { absPath: video, kind: "video" };

  const image = absPaths.find((p) => IMAGE_EXT.has(path.extname(p).toLowerCase()));
  return image ? { absPath: image, kind: "image" } : null;
};

/** CapCut's default project name: a date stamp, "(n)" appended for the
 *  n-th project created that same day. Computed fresh each call from
 *  createdAt + stable id ordering rather than persisted, so it only ever
 *  matters until the user renames (at which point the sidecar wins). */
const defaultBaseName = (createdAt: string): string => {
  const d = new Date(createdAt);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}${dd}`;
};

export const listProjects = (): ProjectSummary[] => {
  const jobs = listJobs();

  const ascending = [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const seenCount = new Map<string, number>();
  const defaultNameFor = new Map<string, string>();
  for (const job of ascending) {
    const base = defaultBaseName(job.createdAt);
    const n = seenCount.get(base) ?? 0;
    defaultNameFor.set(job.id, n === 0 ? base : `${base} (${n})`);
    seenCount.set(base, n + 1);
  }

  return jobs.map((job) => {
    const sidecar = readProjectSidecar(job.id);
    return {
      id: job.id,
      name: sidecar.name?.trim() || defaultNameFor.get(job.id) || job.id,
      formatId: job.formatId,
      createdAt: job.createdAt,
      sizeBytes: projectSizeBytes(job.id),
      durationSec: projectDurationSec(job.id),
      rendered: job.rendered,
      hasEdl: job.completedStages.includes("edl"),
      trashed: Boolean(sidecar.trashedAt),
    };
  });
};

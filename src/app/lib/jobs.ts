import "server-only";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { JobManifestSchema } from "@backend/pipeline/schemas";
import { JobManifest } from "@backend/pipeline/types";
import { repoRoot, artifactsDir, outDir } from "@backend/pipeline/paths";
import { HookFeedbackResultSchema, ScriptSuggestionSchema } from "@backend/content/schemas";
import { HookFeedbackResult, ScriptSuggestion } from "@backend/content/types";
import { sql } from "./db";

/**
 * Job directories ARE the app's "projects" — a job is created the moment a
 * user picks a template, and it's the same jobs/<id>/ the CLI pipeline
 * already understands. No separate database: the filesystem is the store,
 * consistent with how formats/jobs/artifacts already work in this repo.
 */

export const jobsDir = path.join(repoRoot, "jobs");
export const jobDir = (jobId: string): string => path.join(jobsDir, jobId);
const manifestPath = (jobId: string): string => path.join(jobDir(jobId), "job.json");

export type PipelineStage = "filled" | "transcript" | "trim" | "roles" | "edl";
const STAGE_ARTIFACTS: PipelineStage[] = ["filled", "transcript", "trim", "roles", "edl"];

export type JobSummary = {
  id: string;
  formatId: string;
  createdAt: string;
  completedStages: PipelineStage[];
  rendered: boolean;
};

const isValidJobId = (jobId: string): boolean => /^[a-zA-Z0-9._-]+$/.test(jobId);

export const jobExists = (jobId: string): boolean =>
  isValidJobId(jobId) && fs.existsSync(manifestPath(jobId));

export const readJobManifest = (jobId: string): JobManifest => {
  const raw = JSON.parse(fs.readFileSync(manifestPath(jobId), "utf8"));
  const parsed = JobManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`job.json for "${jobId}" failed validation:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
};

export const writeJobManifest = (jobId: string, manifest: JobManifest): void => {
  fs.writeFileSync(manifestPath(jobId), JSON.stringify(manifest, null, 2));
};

/**
 * Script suggestions and hook feedback (see @backend/content/) live beside
 * job.json, not in artifacts/ — they're job CONTENT (a creative aid the
 * user asked for), never read by any pipeline stage, unlike the
 * intake/transcribe/trim/roles/edl artifacts that ARE derived-and-consumed
 * pipeline state.
 */
const scriptPath = (jobId: string): string => path.join(jobDir(jobId), "script.json");
const hookFeedbackPath = (jobId: string): string => path.join(jobDir(jobId), "hook-feedback.json");

export const jobScriptExists = (jobId: string): boolean => fs.existsSync(scriptPath(jobId));

export const readJobScript = (jobId: string): ScriptSuggestion =>
  ScriptSuggestionSchema.parse(JSON.parse(fs.readFileSync(scriptPath(jobId), "utf8")));

export const writeJobScript = (jobId: string, script: ScriptSuggestion): void => {
  fs.writeFileSync(scriptPath(jobId), JSON.stringify(script, null, 2));
};

export const jobHookFeedbackExists = (jobId: string): boolean => fs.existsSync(hookFeedbackPath(jobId));

export const readJobHookFeedback = (jobId: string): HookFeedbackResult =>
  HookFeedbackResultSchema.parse(JSON.parse(fs.readFileSync(hookFeedbackPath(jobId), "utf8")));

export const writeJobHookFeedback = (jobId: string, feedback: HookFeedbackResult): void => {
  fs.writeFileSync(hookFeedbackPath(jobId), JSON.stringify(feedback, null, 2));
};

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Creates jobs/<id>/ with an empty manifest (no slots bound yet), records
 *  `ownerId` as its owner in Postgres (see db/migrations/002_accounts.sql —
 *  middleware.ts and listJobsForUser below are what actually enforce this),
 *  and returns the id. */
export const createJob = async (formatId: string, ownerId: string): Promise<string> => {
  const jobId = `${slugify(formatId)}-${randomBytes(3).toString("hex")}`;
  fs.mkdirSync(path.join(jobDir(jobId), "assets"), { recursive: true });
  writeJobManifest(jobId, { format: formatId, bindings: {}, lexicon: [] });
  await sql`insert into job_owners (job_id, user_id) values (${jobId}, ${ownerId})`;
  return jobId;
};

const stageDone = (jobId: string, stage: PipelineStage): boolean =>
  fs.existsSync(path.join(artifactsDir(jobId), `${stage}.json`));

/**
 * Clears the auto-split (splitTake.json) and multi-clip take prep
 * (takePrep.json — see prepareTake.ts) artifacts after any upload/delete
 * that touches the speaking-take slot: a new/removed/replaced clip
 * invalidates whatever ordering/spans were computed from the OLD set of
 * clips. The derived combined MP4 itself doesn't need deleting here —
 * ensureTakePrep already recomputes it whenever its own input signatures
 * go stale; this only needs to happen on a full slot clear (no clips left
 * at all), to avoid leaving an orphaned file behind.
 */
export const invalidateTakeArtifacts = (jobId: string, clearCombinedFile?: string): void => {
  for (const name of ["splitTake.json", "takePrep.json"]) {
    fs.rmSync(path.join(artifactsDir(jobId), name), { force: true });
  }
  if (clearCombinedFile) {
    fs.rmSync(path.join(jobDir(jobId), clearCombinedFile), { force: true });
  }
};

export const getJobStatus = (jobId: string): { completedStages: PipelineStage[]; rendered: boolean } => ({
  completedStages: STAGE_ARTIFACTS.filter((s) => stageDone(jobId, s)),
  rendered: fs.existsSync(path.join(outDir, `${jobId}.mp4`)),
});

/** Every job on disk, unfiltered — for cross-user/admin concerns (e.g.
 *  formats.ts picking any rendered job as a gallery preview). Anything
 *  showing jobs to a specific signed-in user should go through
 *  listJobsForUser instead. */
export const listJobs = (): JobSummary[] => {
  if (!fs.existsSync(jobsDir)) return [];
  return fs
    .readdirSync(jobsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(manifestPath(d.name)))
    .map((d) => {
      const manifest = readJobManifest(d.name);
      const status = getJobStatus(d.name);
      const createdAt = fs.statSync(manifestPath(d.name)).birthtime.toISOString();
      return { id: d.name, formatId: manifest.format, createdAt, ...status };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};

/** The only jobs meant to be genuinely public example content — checked
 *  into git as the ".gitignore"'s explicit `!jobs/<id>` allow-list, unlike
 *  the many other unowned jobs sitting in jobs/ (real work predating
 *  accounts, e.g. every job created while building this feature). Kept in
 *  sync with middleware.ts's copy of the same list. */
const DEMO_JOB_IDS = new Set(["demo", "five-codes", "five-codes-demo"]);

/** listJobs(), scoped to what `user` may see: everything for an admin,
 *  otherwise jobs they own plus the checked-in demo jobs above — mirrors
 *  middleware.ts's per-job access rule exactly, so nothing shows up in a
 *  listing that a direct link to it would then 404 on. An unowned job
 *  that ISN'T one of the demo ids (pre-accounts dev/test data) stays
 *  admin-only rather than defaulting to "shared with everyone". */
export const listJobsForUser = async (user: { id: string; isAdmin: boolean }): Promise<JobSummary[]> => {
  const jobs = listJobs();
  if (user.isAdmin) return jobs;
  const rows = await sql`select job_id, user_id from job_owners`;
  const ownerOf = new Map((rows as { job_id: string; user_id: string }[]).map((r) => [r.job_id, r.user_id]));
  return jobs.filter((j) => ownerOf.get(j.id) === user.id || DEMO_JOB_IDS.has(j.id));
};

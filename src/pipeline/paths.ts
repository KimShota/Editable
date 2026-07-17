import path from "node:path";

/** Repo root, resolved from this file so the CLI works from any cwd. */
export const repoRoot = path.resolve(__dirname, "..", "..");

export const formatsDir = path.join(repoRoot, "formats");
export const publicDir = path.join(repoRoot, "public");
export const outDir = path.join(repoRoot, "out");
export const modelsDir = path.join(repoRoot, "models");

/** Where a job's inspectable artifacts land. */
export const artifactsDir = (jobId: string): string =>
  path.join(repoRoot, "artifacts", jobId);

/** public/-relative staging prefix for a job's assets (served by staticFile). */
export const publicJobPrefix = (jobId: string): string => `jobs/${jobId}`;

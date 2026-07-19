import path from "node:path";

/**
 * Repo root. Both entry points (the `tsx` CLI and the Next.js app) are run
 * from the repo root by convention, so process.cwd() is the source of
 * truth — a __dirname-relative resolution breaks once this module is
 * bundled (Next/Turbopack rewrites __dirname to a virtual location).
 */
export const repoRoot = process.cwd();

export const formatsDir = path.join(repoRoot, "formats");
export const publicDir = path.join(repoRoot, "public");
export const outDir = path.join(repoRoot, "out");
export const modelsDir = path.join(repoRoot, "models");

/** Where a job's inspectable artifacts land. */
export const artifactsDir = (jobId: string): string =>
  path.join(repoRoot, "artifacts", jobId);

/** public/-relative staging prefix for a job's assets (served by staticFile). */
export const publicJobPrefix = (jobId: string): string => `jobs/${jobId}`;

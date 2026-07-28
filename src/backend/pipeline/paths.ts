import path from "node:path";

/**
 * Repo root. Both entry points (the `tsx` CLI and the Next.js app) are run
 * from the repo root by convention, so process.cwd() is the source of
 * truth — a __dirname-relative resolution breaks once this module is
 * bundled (Next/Turbopack rewrites __dirname to a virtual location).
 */
export const repoRoot = process.cwd();

export const formatsDir = path.join(repoRoot, "formats");
/** Where StyleProfiles live — a subdirectory, not formatsDir itself, since
 *  loader.ts's listFormats() treats every *.json directly in formatsDir as
 *  a Format to enumerate on the templates page. */
export const formatStylesDir = path.join(formatsDir, "styles");
/** Where a format's checked-in template plates (backdrop images, desk
 *  foreground mask, music bed) live — one subdirectory per format id,
 *  same "subdirectory, not formatsDir itself" reasoning as formatStylesDir. */
export const formatAssetsDir = (formatId: string): string =>
  path.join(formatsDir, "assets", formatId);
export const publicDir = path.join(repoRoot, "public");
export const outDir = path.join(repoRoot, "out");
export const modelsDir = path.join(repoRoot, "models");

/** Where a job's inspectable artifacts land. */
export const artifactsDir = (jobId: string): string =>
  path.join(repoRoot, "artifacts", jobId);

/** public/-relative staging prefix for a job's assets (served by staticFile). */
export const publicJobPrefix = (jobId: string): string => `jobs/${jobId}`;

/** Where a format-authoring draft's working files (reference clip, sampled
 *  frames, analysis/draft artifacts) land — the authoring-pipeline analog
 *  of artifactsDir. */
export const authoringDir = (draftId: string): string =>
  path.join(repoRoot, "authoring", draftId);

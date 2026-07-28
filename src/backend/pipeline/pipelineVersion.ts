/**
 * Folded into every generation-cache hash (generate.ts, backgroundReplace.ts).
 * Bump this whenever a code change alters what a cached artifact looks like
 * (a new ffmpeg filter, a different composite layer order, a relight curve
 * fix, ...) — the hash inputs alone don't capture "the code that consumes
 * them changed", so a stale cache would otherwise silently keep serving a
 * pre-fix artifact forever. Bumping busts every existing cache entry.
 */
export const PIPELINE_VERSION = "2026-07-28.1";

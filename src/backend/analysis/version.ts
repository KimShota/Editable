/**
 * Half of the cache key for a stored VideoAnalysis (the other half is the
 * media's content hash) — same idea as pipelineVersion.ts. Bump this
 * whenever a change to the analyzer alters what it MEASURES (a different
 * cut threshold, a new field, a fixed bug in the beat tracker): the hash
 * alone can't tell that the code consuming it changed, so a stale row would
 * otherwise be served forever as if it were current. Bumping adds new rows
 * alongside the old ones; nothing is deleted.
 */
export const ANALYZER_VERSION = "2026-09-29.1";

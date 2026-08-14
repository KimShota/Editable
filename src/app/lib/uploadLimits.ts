/**
 * Per-file upload size ceilings, enforced explicitly in each upload route
 * so an oversized file gets a clean 413 instead of silently hitting
 * Next's own body-size cap (next.config.mjs's proxyClientMaxBodySize,
 * which truncates rather than erroring) or growing a job/library
 * directory without bound.
 */

/** 2GB — matches next.config.mjs's proxyClientMaxBodySize. A
 *  phone-recorded speaking take can legitimately be this large. */
export const MAX_JOB_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

/** 500MB — sfx/memes/gifs/music/screen-recordings are reusable clips a
 *  user drops into slots repeatedly, not raw takes, so this stays well
 *  under the job-asset ceiling. */
export const MAX_LIBRARY_ASSET_BYTES = 500 * 1024 * 1024;

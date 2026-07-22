import "server-only";
import fs from "node:fs";
import path from "node:path";
import { publicDir } from "@backend/pipeline/paths";

/**
 * Resolves a public/-relative asset src as it appears in an EDL (e.g.
 * "jobs/<jobId>/assets/clip.mov") to its absolute path, verifying it
 * actually belongs to the given job and can't escape the job's asset dir
 * however the path got encoded.
 */
export const resolveJobAssetAbsPath = (jobId: string, src: string): string | null => {
  const prefix = `jobs/${jobId}/assets/`;
  if (!src.startsWith(prefix)) return null;
  const assetsDir = path.join(publicDir, "jobs", jobId, "assets");
  const resolved = path.join(publicDir, src);
  if (resolved !== assetsDir && !resolved.startsWith(assetsDir + path.sep)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
};

/** Cache path for a generated preview asset, alongside the original:
 *  public/jobs/<jobId>/assets/_previews/<basename><suffix>. */
export const previewCachePath = (sourceAbsPath: string, suffix: string): string => {
  const dir = path.join(path.dirname(sourceAbsPath), "_previews");
  const base = path.basename(sourceAbsPath, path.extname(sourceAbsPath));
  return path.join(dir, `${base}${suffix}`);
};

/** The public/ URL a cache path is reachable at once written — Next's
 *  static file server handles it directly from there on (Range requests
 *  included), no further routing through this API needed. */
export const previewCacheUrl = (cacheAbsPath: string): string =>
  "/" + path.relative(publicDir, cacheAbsPath).split(path.sep).join("/");

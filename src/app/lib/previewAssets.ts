import "server-only";
import fs from "node:fs";
import path from "node:path";
import { publicDir } from "@backend/pipeline/paths";

/** The subdirectories an EDL src can point into under a job's public dir:
 *  user-uploaded footage, clips synthesized by the generate stage (see
 *  generate.ts's `generatedDir`), and a multi-clip speaking take's derived,
 *  combined file (see prepareTake.ts's `ensureTakePrep` — the ONLY thing
 *  ever written under "derived") — all staged to public/ the same way, so
 *  the preview proxy must resolve any of them. Missing "derived" here left
 *  every segment of a multi-clip take 404ing through the proxy (valid
 *  path, just rejected by this allowlist), which the browser then reports
 *  as a generic "error while playing the video" — no video element ever
 *  gets a real video to decode. */
const ALLOWED_SUBDIRS = ["assets", "generated", "derived"];

/**
 * Resolves a public/-relative asset src as it appears in an EDL (e.g.
 * "jobs/<jobId>/assets/clip.mov" or "jobs/<jobId>/generated/clip.mp4") to
 * its absolute path, verifying it actually belongs to the given job and
 * can't escape its subdirectory however the path got encoded.
 */
export const resolveJobAssetAbsPath = (jobId: string, src: string): string | null => {
  const jobPrefix = `jobs/${jobId}/`;
  if (!src.startsWith(jobPrefix)) return null;
  const subdir = src.slice(jobPrefix.length).split("/")[0];
  if (!ALLOWED_SUBDIRS.includes(subdir)) return null;
  const subdirAbs = path.join(publicDir, "jobs", jobId, subdir);
  const resolved = path.join(publicDir, src);
  if (resolved !== subdirAbs && !resolved.startsWith(subdirAbs + path.sep)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
};

/**
 * Cache path for a generated preview asset, alongside the original:
 * public/jobs/<jobId>/assets/_previews/<basename>.<fingerprint><suffix>.
 *
 * The fingerprint (source size + mtime, the same pair weakETag in the media
 * route already treats as "identifies this file's content") makes the path
 * itself change whenever the source does, which is what lets
 * next.config.mjs cache these responses `immutable` — a URL that never
 * changes for changed content is exactly what an immutable cache isn't
 * safe for. Before this, ensurePreviewProxy/-Thumbnail relied on an mtime
 * check to know when to regenerate, silently overwriting the SAME
 * filename in place; a client that had that filename cached (or a CDN in
 * front of one) would keep serving the old bytes after a re-upload with no
 * way to know they'd gone stale. Content-addressing trades that for a
 * smaller cost: replacing a source's content orphans its old cache file
 * instead of overwriting it (harmless — these are small proxies/thumbnails,
 * not the source footage itself — but worth knowing if _previews/ disk
 * usage ever needs trimming). */
export const previewCachePath = (sourceAbsPath: string, suffix: string): string => {
  const dir = path.join(path.dirname(sourceAbsPath), "_previews");
  const base = path.basename(sourceAbsPath, path.extname(sourceAbsPath));
  const stat = fs.statSync(sourceAbsPath);
  const fingerprint = `${stat.size.toString(36)}.${Math.round(stat.mtimeMs).toString(36)}`;
  return path.join(dir, `${base}.${fingerprint}${suffix}`);
};

/** The public/ URL a cache path is reachable at once written — Next's
 *  static file server handles it directly from there on (Range requests
 *  included), no further routing through this API needed. */
export const previewCacheUrl = (cacheAbsPath: string): string =>
  "/" + path.relative(publicDir, cacheAbsPath).split(path.sep).join("/");

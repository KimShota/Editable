import type { QueryFn } from "../../app/lib/db";
import { deriveVideoEmbedding } from "./embedding";
import { type StyleFeatures, StyleFeaturesSchema, type VideoAnalysis, VideoAnalysisSchema } from "./schemas";
import { toVectorLiteral } from "../style/vector";

/**
 * videos / video_analyses persistence (db/migrations/011). The analysis is
 * keyed by (content hash, analyzer version): the same bytes are analyzed once
 * per analyzer version, no matter how many videos rows or users point at them.
 */

export type VideoRelation = "own" | "reference" | "library";

export type VideoRow = {
  id: string;
  ownerId: string | null;
  relation: VideoRelation;
  mediaKey: string | null;
  contentHash: string | null;
  durationSec: number | null;
};

export type NewVideo = {
  ownerId: string | null;
  relation: VideoRelation;
  platform?: string;
  platformVideoId?: string;
  url?: string;
  postedAt?: Date;
  mediaKey?: string;
  contentHash?: string;
  durationSec?: number;
};

export const insertVideo = async (query: QueryFn, v: NewVideo): Promise<string> => {
  const rows = await query(
    `insert into videos (owner_id, relation, platform, platform_video_id, url, posted_at, media_key, content_hash, duration_sec)
     values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9)
     returning id`,
    [
      v.ownerId,
      v.relation,
      v.platform ?? null,
      v.platformVideoId ?? null,
      v.url ?? null,
      v.postedAt ? v.postedAt.toISOString() : null,
      v.mediaKey ?? null,
      v.contentHash ?? null,
      v.durationSec ?? null,
    ],
  );
  return String(rows[0].id);
};

export const getVideo = async (query: QueryFn, id: string): Promise<VideoRow | null> => {
  const rows = await query(
    `select id, owner_id, relation, media_key, content_hash, duration_sec from videos where id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: String(r.id),
    ownerId: r.owner_id === null ? null : String(r.owner_id),
    relation: r.relation as VideoRelation,
    mediaKey: r.media_key === null ? null : String(r.media_key),
    contentHash: r.content_hash === null ? null : String(r.content_hash),
    durationSec: r.duration_sec === null ? null : Number(r.duration_sec),
  };
};

export const setVideoMedia = async (
  query: QueryFn,
  id: string,
  patch: { mediaKey?: string | null; contentHash?: string; durationSec?: number },
): Promise<void> => {
  // Each field is set only when supplied; `mediaKey: null` is a real value
  // (the media was deleted) and is distinct from "leave it alone".
  await query(
    `update videos set
       media_key    = case when $2::boolean then $3 else media_key end,
       content_hash = coalesce($4, content_hash),
       duration_sec = coalesce($5, duration_sec)
     where id = $1`,
    [id, "mediaKey" in patch, patch.mediaKey ?? null, patch.contentHash ?? null, patch.durationSec ?? null],
  );
};

export type StoredAnalysis = { analysis: VideoAnalysis; features: StyleFeatures };

/** The stored analysis for this content at this analyzer version, or null.
 *  Rows are re-validated on read: a row written by an older shape fails
 *  loudly here rather than feeding a consumer something it can't use. */
export const getAnalysis = async (query: QueryFn, contentHash: string, analyzerVersion: string): Promise<StoredAnalysis | null> => {
  const rows = await query(
    `select analysis, style_features from video_analyses where content_hash = $1 and analyzer_version = $2`,
    [contentHash, analyzerVersion],
  );
  if (rows.length === 0) return null;
  return {
    analysis: VideoAnalysisSchema.parse(rows[0].analysis),
    features: StyleFeaturesSchema.parse(rows[0].style_features),
  };
};

/** Idempotent per (hash, version): re-saving replaces the row, which is how
 *  a later semantic pass upgrades an analysis that was first stored without one. */
export const saveAnalysis = async (query: QueryFn, contentHash: string, result: StoredAnalysis): Promise<void> => {
  const analysis = VideoAnalysisSchema.parse(result.analysis);
  const features = StyleFeaturesSchema.parse(result.features);
  await query(
    `insert into video_analyses (content_hash, analyzer_version, analysis, style_features, style_vec)
     values ($1, $2, $3::jsonb, $4::jsonb, $5::vector)
     on conflict (content_hash, analyzer_version) do update
       set analysis = excluded.analysis, style_features = excluded.style_features, style_vec = excluded.style_vec`,
    [
      contentHash,
      analysis.analyzerVersion,
      JSON.stringify(analysis),
      JSON.stringify(features),
      toVectorLiteral(deriveVideoEmbedding(features)),
    ],
  );
};

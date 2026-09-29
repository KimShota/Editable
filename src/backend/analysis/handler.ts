import type { QueryFn } from "../../app/lib/db";
import type { JobHandler } from "../queue/worker";
import type { EnqueueOptions, WorkQueue } from "../queue/workQueue";
import { hashFile, type Storage } from "../storage";
import { type AnalyzeOptions, analyzeVideoFile } from "./analyzer";
import { getAnalysis, getVideo, saveAnalysis, setVideoMedia } from "./store";
import { ANALYZER_VERSION } from "./version";

/**
 * The `analyze` job: one videos row in, one video_analyses row out.
 *
 * Idempotent, because the queue is at-least-once: running it twice on the
 * same video (a worker died after saving but before completing) finds the
 * stored analysis and returns without re-running ffmpeg. That is also what
 * makes the same file uploaded by two users cost one analysis.
 */

export const ANALYZE_KIND = "analyze";

export type AnalyzePayload = { videoId: string };

export type AnalysisHandlerDeps = {
  query: QueryFn;
  storage: Storage;
  /** Passed through to the analyzer (semantic provider, transcript/OCR switches). */
  analyzeOptions?: AnalyzeOptions;
};

export type AnalyzeJobResult = { videoId: string; contentHash: string; cached: boolean };

/** Enqueues analysis of one video. Deduped on (video, analyzer version): a
 *  second request while one is queued or running is a no-op, but a bumped
 *  ANALYZER_VERSION is a new job. Returns null if it was deduped. */
export const enqueueAnalysis = (queue: WorkQueue, videoId: string, opts: EnqueueOptions = {}): Promise<number | null> =>
  queue.enqueue(ANALYZE_KIND, { videoId } satisfies AnalyzePayload, {
    dedupeKey: `${videoId}:${ANALYZER_VERSION}`,
    ...opts,
  });

const parsePayload = (payload: unknown): AnalyzePayload => {
  const videoId = (payload as { videoId?: unknown } | null)?.videoId;
  if (typeof videoId !== "string" || videoId.length === 0) throw new Error("analyze job: payload needs a videoId");
  return { videoId };
};

export const createAnalyzeHandler =
  ({ query, storage, analyzeOptions }: AnalysisHandlerDeps): JobHandler =>
  async (job): Promise<AnalyzeJobResult> => {
    const { videoId } = parsePayload(job.payload);
    const video = await getVideo(query, videoId);
    if (!video) throw new Error(`analyze job: video ${videoId} does not exist`);
    if (!video.mediaKey) throw new Error(`analyze job: video ${videoId} has no media (already deleted?)`);

    const localFile = await storage.localPath(video.mediaKey);
    const contentHash = video.contentHash ?? (await hashFile(localFile));
    if (!video.contentHash) await setVideoMedia(query, videoId, { contentHash });

    const cached = (await getAnalysis(query, contentHash, ANALYZER_VERSION)) !== null;
    if (!cached) {
      const result = await analyzeVideoFile(localFile, { ...analyzeOptions, contentHash });
      await saveAnalysis(query, contentHash, result);
      await setVideoMedia(query, videoId, { durationSec: result.analysis.media.durationSec });
    }

    // Another creator's reel: keep only what was derived from it. The media
    // goes once it has been measured (plan G / section 8, ToS mitigation) —
    // done even on a cache hit, so a duplicate reference is cleaned up too.
    if (video.relation === "reference") {
      await storage.remove(video.mediaKey);
      await setVideoMedia(query, videoId, { mediaKey: null });
    }

    return { videoId, contentHash, cached };
  };

/** The job kinds an analysis worker handles. */
export const createAnalysisHandlers = (deps: AnalysisHandlerDeps): Record<string, JobHandler> => ({
  [ANALYZE_KIND]: createAnalyzeHandler(deps),
});

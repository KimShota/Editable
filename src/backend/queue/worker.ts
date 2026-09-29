import { QueueJob, WorkQueue } from "./workQueue";

/**
 * The worker loop over a WorkQueue. Kept apart from the SQL (workQueue.ts)
 * so the retry / lost-lock / graceful-stop behavior can be exercised
 * against an in-process database, and apart from the CLI (workerCli.ts) so
 * a future dedicated worker box runs the same code.
 */

export type JobHandler = (job: QueueJob) => Promise<unknown>;

export type WorkerOptions = {
  queue: WorkQueue;
  /** kind → handler. Only these kinds are ever claimed. */
  handlers: Record<string, JobHandler>;
  workerId: string;
  /** Jobs in flight at once. Default 1 — analysis is minutes of ffmpeg CPU,
   *  the same constraint pipelineQueue.ts caps for build/render. */
  concurrency?: number;
  /** Sleep between empty polls. Default 2000. */
  pollMs?: number;
  /** A running job whose lock is older than this is presumed dead and
   *  reclaimed. Long jobs stay alive by heartbeat (below). Default 1800. */
  lockTimeoutSec?: number;
  /** First retry delay; doubles each attempt. Default 30. */
  retryBaseSec?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
};

/** Claims and runs at most one job. Returns false if nothing was runnable.
 *  A handler error is recorded on the job, never thrown to the caller. */
export const runOnce = async (opts: WorkerOptions): Promise<boolean> => {
  const { queue, handlers, workerId, log = () => {} } = opts;
  const job = await queue.claim(workerId, Object.keys(handlers));
  if (!job) return false;

  const lockTimeoutSec = opts.lockTimeoutSec ?? 1800;
  // Refresh the lock at a third of the timeout so a healthy long job is
  // never mistaken for a dead one. `unref` so a stuck timer can't keep the
  // process alive after the job settles.
  const heartbeat = setInterval(() => {
    queue.touch(job, workerId).catch((err) => log(`job ${job.id}: heartbeat failed: ${err}`));
  }, Math.max(1000, (lockTimeoutSec * 1000) / 3));
  heartbeat.unref();

  const startedAt = Date.now();
  try {
    const result = await handlers[job.kind](job);
    const held = await queue.complete(job, workerId, result);
    log(
      held
        ? `job ${job.id} (${job.kind}) done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
        : `job ${job.id} (${job.kind}) finished but its lock had been reclaimed — result discarded`,
    );
  } catch (err) {
    const outcome = await queue.fail(job, workerId, err, opts.retryBaseSec);
    log(`job ${job.id} (${job.kind}) attempt ${job.attempts}/${job.maxAttempts} failed → ${outcome}: ${err instanceof Error ? err.message : err}`);
  } finally {
    clearInterval(heartbeat);
  }
  return true;
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done);
  });

/** Runs until `signal` aborts, then lets in-flight jobs finish (a graceful
 *  stop — SIGTERM during a deploy doesn't orphan a half-analyzed video). */
export const runWorker = async (opts: WorkerOptions): Promise<void> => {
  const { queue, signal, log = () => {} } = opts;
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const pollMs = opts.pollMs ?? 2000;
  const lockTimeoutSec = opts.lockTimeoutSec ?? 1800;

  const reclaim = async () => {
    try {
      const n = await queue.reclaimStale(lockTimeoutSec);
      if (n > 0) log(`reclaimed ${n} stale job(s)`);
    } catch (err) {
      log(`reclaim failed: ${err}`);
    }
  };
  await reclaim();
  const reclaimTimer = setInterval(reclaim, Math.max(1000, (lockTimeoutSec * 1000) / 6));
  reclaimTimer.unref();

  const loop = async () => {
    while (!signal?.aborted) {
      let ran = false;
      try {
        ran = await runOnce(opts);
      } catch (err) {
        // The queue itself is unreachable (DB down) — back off, don't spin.
        log(`queue error: ${err instanceof Error ? err.message : err}`);
      }
      if (!ran) await sleep(pollMs, signal);
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, loop));
  } finally {
    clearInterval(reclaimTimer);
  }
};

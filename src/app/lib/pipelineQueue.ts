import "server-only";

/**
 * Caps how many pipeline child processes run at once, shared across both
 * spawn sites (api/jobs/[jobId]/build and .../render) — both shell out to
 * `npm run pipeline`, which in turn runs ffmpeg/whisper-cli/Remotion's
 * headless Chromium: minutes of real CPU and memory each, not the kind of
 * work a friends-scale box (a handful of cores) can run unbounded copies of
 * concurrently. `next start` is a single Node process, so a module-level
 * counter is enough — no Redis/external queue needed at this scale.
 */

const MAX_CONCURRENT = Number(process.env.PIPELINE_MAX_CONCURRENT) || 2;

let running = 0;
const waiters: Array<() => void> = [];

/**
 * Resolves once a slot is free (immediately if under the cap) with a
 * release function the caller MUST invoke exactly once when its child
 * process exits — typically from the "close" handler, on every exit path
 * (success, failure, or crash) so a stuck slot never wedges the queue.
 */
export const acquirePipelineSlot = (): Promise<() => void> =>
  new Promise((resolve) => {
    const grant = () => {
      running++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        running--;
        const next = waiters.shift();
        if (next) next();
      });
    };
    if (running < MAX_CONCURRENT) {
      grant();
    } else {
      waiters.push(grant);
    }
  });

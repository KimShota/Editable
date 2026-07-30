/**
 * A hard, unconditional timeout wrapper — `Promise.race` against a plain
 * `setTimeout`, deliberately NOT relying solely on `fetch`'s own
 * `AbortSignal.timeout` or an SDK's own internal timeout option. Both of
 * those are the right FIRST line of defense (they actually cancel the
 * underlying request, freeing the socket) and stay in place at their own
 * call sites — this is the second line: even if a fetch/SDK's own timeout
 * has an edge case that doesn't fire (observed directly this session: a
 * generate-stage run stalled for 20+ minutes past where BOTH the 120s
 * Gemini AbortSignal and the 60s Anthropic SDK timeout should have
 * already fired and moved the retry ladder along), the calling code here
 * still gets its promise settled on schedule and can proceed with its own
 * error handling / retry / fallback. The abandoned inner call keeps
 * running until ITS OWN mechanism eventually gives up (or the process
 * exits) — this doesn't kill it, it just stops this code from waiting on
 * it forever.
 */
export const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}: hard timeout after ${ms}ms — no response`)), ms);
      // Doesn't hold the process open waiting on this timer alone if
      // everything else has already finished/exited.
      timer.unref?.();
    }),
  ]);

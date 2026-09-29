import "dotenv/config";
import os from "node:os";
import { query } from "../../app/lib/db";
import { createAnalysisHandlers } from "../analysis/handler";
import { ClaudeSemanticProvider } from "../analysis/semantic";
import { getStorage } from "../storage";
import { runWorker } from "./worker";
import { WorkQueue } from "./workQueue";

/**
 * The queue worker process.
 *
 *   npm run worker
 *
 * Env: WORKER_CONCURRENCY (default 1), WORKER_POLL_MS (2000),
 *      ANALYSIS_SEMANTIC=1 to run the Claude semantic pass on each analysis
 *      (costs an API call per new video).
 *
 * SIGINT/SIGTERM stop it gracefully: no new job is claimed, and a job in
 * flight is allowed to finish. On a Phase-2 worker box this is the same
 * command pointed at the same DATABASE_URL.
 */

const main = async (): Promise<void> => {
  const queue = new WorkQueue(query);
  const workerId = `${os.hostname()}:${process.pid}`;
  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`${sig} received — finishing in-flight jobs, then exiting`);
      controller.abort();
    });
  }

  const handlers = createAnalysisHandlers({
    query,
    storage: getStorage(),
    analyzeOptions: { semantic: process.env.ANALYSIS_SEMANTIC === "1" ? new ClaudeSemanticProvider() : undefined },
  });

  console.log(`worker ${workerId} up; handling: ${Object.keys(handlers).join(", ")}`);
  await runWorker({
    queue,
    handlers,
    workerId,
    concurrency: Number(process.env.WORKER_CONCURRENCY) || 1,
    pollMs: Number(process.env.WORKER_POLL_MS) || 2000,
    signal: controller.signal,
    log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
  });
  console.log("worker stopped");
};

main().catch((err) => {
  console.error("worker crashed:", err);
  process.exit(1);
});

import type { QueryFn } from "../../app/lib/db";
import { adaptCard, buildSpec, ingestSource, storyboardCard } from "../recreation/ops";
import { claudeProposer } from "../plan/propose";
import type { JobHandler } from "../queue/worker";
import type { Storage } from "../storage";
import { brandCostSink, type JobDeps } from "./deps";
import { pingHandler } from "./ping";
import { createPlanHandlers } from "./planJobs";
import { stubDeps } from "./stubs";

/**
 * Every job kind the app can start, and its handler (plan/ui-ux-full-flow.md
 * §2.4). The worker loads this next to the analysis handlers. New kinds are
 * added here as each slice lands; a kind that is enqueued but not
 * registered is never claimed, so it just stays queued.
 *
 * Handlers call the same functions the CLIs call and write their progress
 * through `ctx.report`. They must be idempotent: the queue is at-least-once.
 *
 * With KATALAB_STUB_PROVIDERS=1 the paid parts (downloading, Claude, image
 * generation) are replaced by deterministic stand-ins (jobs/stubs.ts).
 */

export const realDeps = (query: QueryFn, storage: Storage): JobDeps => ({
  query,
  storage,
  ops: { ingestSource, buildSpec, adaptCard, storyboardCard },
  proposer: (costSink, ref) => claudeProposer({ costSink, ref }),
  costSinkFor: (slug) => brandCostSink(query, slug),
});

export const createJobHandlers = (query: QueryFn, storage: Storage): Record<string, JobHandler> => {
  const base = { query, storage, costSinkFor: (slug: string) => brandCostSink(query, slug) };
  const deps = process.env.KATALAB_STUB_PROVIDERS === "1" ? stubDeps(base) : realDeps(query, storage);
  return {
    "system.ping": pingHandler,
    ...createPlanHandlers(deps),
  };
};

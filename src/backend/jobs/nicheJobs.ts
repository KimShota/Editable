import { z } from "zod";
import { proposeNiche } from "../niche/ops";
import { type JobContext, type JobHandler, NO_CONTEXT } from "../queue/worker";
import type { JobDeps } from "./deps";
import { TaskPayloadSchema } from "./payload";

/**
 * `niche.propose`: 3 to 5 content angles for the brand, saved as niche.json
 * (plan/ui-ux-full-flow.md §3, onboarding step 4). The customer then picks
 * one (backend/niche/choose.ts). The work is niche/ops.ts, shared with the CLI.
 */
export const createNicheHandlers = (deps: JobDeps): Record<string, JobHandler> => ({
  "niche.propose": async (job, ctx: JobContext = NO_CONTEXT) => {
    const { slug } = TaskPayloadSchema.and(z.object({})).parse(job.payload);
    const count = await proposeNiche(deps.storage, slug, deps.nicheProposer(deps.costSinkFor(slug), `${slug}/niche`), (stage) => ctx.report({ stage }));
    ctx.report({ stage: "Angles ready", done: count, total: count });
    return { angles: count };
  },
});

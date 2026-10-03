import { z } from "zod";
import { type JobContext, NO_CONTEXT } from "../queue/worker";
import type { QueueJob } from "../queue/workQueue";
import { TaskPayloadSchema } from "./payload";

/**
 * `system.ping`: counts to `steps`, reporting progress each step, and can be
 * told to fail. It costs nothing and touches nothing, so it is how the
 * progress UI and the whole enqueue → worker → /api/tasks path are tested
 * and demoed without a paid provider.
 */
const PingPayloadSchema = TaskPayloadSchema.and(
  z.object({
    steps: z.number().int().min(1).max(50).default(5),
    stepMs: z.number().int().min(0).max(5000).default(400),
    failWith: z.string().optional(),
  }),
);

export const pingHandler = async (job: QueueJob, ctx: JobContext = NO_CONTEXT): Promise<{ steps: number }> => {
  const { steps, stepMs, failWith } = PingPayloadSchema.parse(job.payload);
  for (let i = 1; i <= steps; i++) {
    ctx.report({ stage: "Counting", done: i - 1, total: steps, message: `step ${i} of ${steps}` });
    await new Promise((resolve) => setTimeout(resolve, stepMs));
    if (failWith && i === Math.ceil(steps / 2)) throw new Error(failWith);
  }
  ctx.report({ stage: "Counting", done: steps, total: steps });
  return { steps };
};

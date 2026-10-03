import "server-only";
import { type TaskPayload, TaskPayloadSchema, taskDedupeKey } from "@backend/jobs/payload";
import { type EnqueueOptions, WorkQueue } from "@backend/queue/workQueue";
import { query } from "./db";

/**
 * Starts work for a brand as a queue job (plan/ui-ux-full-flow.md §2.4).
 * Callers must have checked that the user may open `payload.slug` first
 * (brandRepo.assertAccess): /api/tasks trusts the slug in the payload to
 * decide who may watch the job.
 *
 * Returns the task id to hand to <TaskProgress>, or null when an identical
 * job (same kind, brand, card and discriminator) is already queued or
 * running: the caller should then look it up with listTasks.
 */
export const queue = new WorkQueue(query);

export const enqueueBrandTask = async (
  kind: string,
  payload: TaskPayload,
  opts: Omit<EnqueueOptions, "dedupeKey"> & { discriminator?: string } = {},
): Promise<number | null> => {
  const parsed = TaskPayloadSchema.parse(payload);
  const { discriminator, ...rest } = opts;
  return queue.enqueue(kind, parsed, { ...rest, dedupeKey: `${kind}:${taskDedupeKey(parsed, discriminator)}` });
};

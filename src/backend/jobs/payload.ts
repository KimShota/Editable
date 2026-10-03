import { z } from "zod";
import { isBrandSlug } from "../brand/keys";

/**
 * What every job the app starts carries (plan/ui-ux-full-flow.md §2.4). The
 * brand slug is how /api/tasks decides who may watch a job, and `cardId` is
 * how a page finds the jobs for one card after a reload. Handlers add their
 * own fields on top.
 */
export const TaskPayloadSchema = z
  .object({
    slug: z.string().refine(isBrandSlug, "not a brand slug"),
    cardId: z.string().optional(),
  })
  .passthrough();

export type TaskPayload = z.infer<typeof TaskPayloadSchema>;

/** Same (kind, brand, card) while one is queued or running: a no-op, so a
 *  double-click never starts two. Callers add a discriminator (a source id,
 *  a URL) when one card can legitimately have several at once. */
export const taskDedupeKey = (payload: TaskPayload, discriminator = ""): string =>
  [payload.slug, payload.cardId ?? "", discriminator].join(":");

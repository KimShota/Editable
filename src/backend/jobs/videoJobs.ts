import { z } from "zod";
import { BrandRepo } from "../brand/repo";
import { transitionCardInPlan, updatePlan } from "../plan/store";
import { type JobContext, type JobHandler, NO_CONTEXT } from "../queue/worker";
import { TaskPayloadSchema } from "./payload";
import type { JobDeps } from "./deps";

/**
 * The jobs behind the video screens (plan/ui-ux-full-flow.md §2.4, §8):
 *
 *   video.estimate   what producing a card would cost (no clip is paid for)
 *   video.produce    voice, clips and render: the paid run, released by the founder
 *   clip.regenerate  one new take of one clip, from the editor
 *
 * video.produce spends real money, so it is enqueued with a single attempt
 * (the queue would otherwise retry a failed run, and pay again) and moves the
 * card through queued → generating → internal_review, or to failed.
 */

const CardPayload = TaskPayloadSchema.and(z.object({ cardId: z.string() }));
const RegenPayload = TaskPayloadSchema.and(z.object({ cardId: z.string(), clipId: z.string().regex(/^[A-Za-z0-9._-]+$/), planId: z.string().regex(/^[A-Za-z0-9-]+$/).optional() }));

/** The message to keep when a run fails: the person reading it is the founder. */
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 500);

export const createVideoHandlers = (deps: JobDeps): Record<string, JobHandler> => {
  const { storage, query } = deps;
  const repo = new BrandRepo(query, storage);

  return {
    "video.estimate": async (job, ctx: JobContext = NO_CONTEXT) => {
      const { slug, cardId } = CardPayload.parse(job.payload);
      const card = await repo.getCard(slug, cardId);
      if (!card) throw new Error(`no card ${cardId}`);
      if (!(await repo.getScript(slug, cardId))) throw new Error(`card ${cardId} has no script yet`);
      ctx.report({ stage: "Estimating the cost" });
      const { usd, maxUsd } = await deps.production.estimate({ storage, costSink: deps.costSinkFor(slug), report: ctx.report }, slug, cardId);
      await updatePlan(storage, slug, (plan) => ({ ...plan, cards: plan.cards.map((c) => (c.id === cardId ? { ...c, estimateUsd: usd, estimateMaxUsd: maxUsd } : c)) }));
      return { usd, maxUsd };
    },

    "video.produce": async (job, ctx: JobContext = NO_CONTEXT) => {
      const { slug, cardId } = CardPayload.parse(job.payload);
      const card = await repo.getCard(slug, cardId);
      if (!card) throw new Error(`no card ${cardId}`);
      // Only a card the founder released. Anything else is a stale or forged
      // job, and must not spend money.
      if (card.status !== "queued") throw new Error(`card ${cardId} is ${card.status}, not queued: refusing to produce it`);

      await transitionCardInPlan(storage, slug, cardId, "generating", "system");
      try {
        const { flagged } = await deps.production.produce({ storage, costSink: deps.costSinkFor(slug), report: ctx.report }, slug, cardId);
        await transitionCardInPlan(storage, slug, cardId, "internal_review", "system", { lowConfidence: flagged.length > 0 });
        return { flagged };
      } catch (err) {
        await transitionCardInPlan(storage, slug, cardId, "failed", "system").catch(() => undefined);
        throw new Error(reason(err));
      }
    },

    "clip.regenerate": async (job, ctx: JobContext = NO_CONTEXT) => {
      const { slug, cardId, clipId, planId } = RegenPayload.parse(job.payload);
      if (!(await repo.getCard(slug, cardId))) throw new Error(`no card ${cardId}`);
      const jobId = `${slug}-${cardId}`;
      await deps.production.regenerate({ storage, costSink: deps.costSinkFor(slug), report: ctx.report }, jobId, clipId, planId);
      return { clipId };
    },
  };
};

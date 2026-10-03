import { z } from "zod";
import { BrandRepo } from "../brand/repo";
import { recreationKeys } from "../brand/keys";
import { addDays, todayIn } from "../plan/dates";
import { type PoolSource, pickAlternates } from "../plan/propose";
import { CYCLE_DAYS, type Card } from "../plan/schemas";
import { readPlan, savePlan, updatePlan } from "../plan/store";
import { type JobContext, type JobHandler, NO_CONTEXT } from "../queue/worker";
import { WorkQueue } from "../queue/workQueue";
import { sourceIdFromUrl } from "../recreation/decompose";
import { parseViralUrl } from "../recreation/viralUrl";
import { TaskPayloadSchema, taskDedupeKey } from "./payload";
import type { JobDeps } from "./deps";

/**
 * The jobs behind the Plan screens (plan/ui-ux-full-flow.md §2.4):
 *
 *   source.ingest    a viral link → downloaded and decomposed into a spec
 *   plan.build       fills the free days of the 14-day plan, then adapts each
 *   card.adapt       writes (or rewrites) one card's script
 *   card.storyboard  one still per shot for a card
 *
 * Each is idempotent (the queue is at-least-once) and checks that a card is
 * still a draft before changing anything about it: once a customer approves
 * a card its words are theirs.
 */

const IngestPayload = TaskPayloadSchema.and(z.object({ url: z.string() }));
const AdaptPayload = TaskPayloadSchema.and(z.object({ cardId: z.string(), note: z.string().max(500).optional() }));
const CardPayload = TaskPayloadSchema.and(z.object({ cardId: z.string() }));
const BuildPayload = TaskPayloadSchema.and(z.object({ days: z.number().int().min(1).max(CYCLE_DAYS).optional() }));

/** The prompt direction for a card: its angle, and any note from the person
 *  who asked for a rewrite. */
export const directionFor = (angle: string, note?: string): string =>
  [`Make this video about: ${angle}`, note ? `Note from the customer: ${note}` : null].filter(Boolean).join("\n");

export const createPlanHandlers = (deps: JobDeps): Record<string, JobHandler> => {
  const { storage, query } = deps;
  const repo = new BrandRepo(query, storage);
  const queue = new WorkQueue(query);

  const adaptJob = async (slug: string, cardId: string, note: string | undefined, ctx: JobContext) => {
    const card = await repo.getCard(slug, cardId);
    if (!card) throw new Error(`no card ${cardId}`);
    if (card.status !== "draft") throw new Error(`card ${cardId} is ${card.status}: only a draft can be rewritten`);
    const script = await deps.ops.adaptCard(
      { storage, costSink: deps.costSinkFor(slug), report: ctx.report },
      slug,
      cardId,
      card.sourceId,
      { direction: directionFor(card.angle, note) },
    );
    await updatePlan(storage, slug, (plan) => ({ ...plan, cards: plan.cards.map((c) => (c.id === cardId ? { ...c, hook: script.lines[0]?.text ?? c.hook } : c)) }));
    return { cardId, lines: script.lines.length };
  };

  return {
    "source.ingest": async (job, ctx = NO_CONTEXT) => {
      const { slug, url: raw } = IngestPayload.parse(job.payload);
      const url = parseViralUrl(raw); // again: the payload is only data in a table
      const k = recreationKeys(slug);
      ctx.report({ stage: "Downloading the video" });
      // Already downloaded (a retry, or someone pasted the same link): skip.
      const id = sourceIdFromUrl(url);
      if (!(await storage.exists(k.video(id)))) await deps.ops.ingestSource(storage, slug, url);
      if (!(await storage.exists(k.spec(id)))) await deps.ops.buildSpec({ storage, costSink: deps.costSinkFor(slug), report: ctx.report }, slug, id);
      return { sourceId: id };
    },

    "card.adapt": async (job, ctx = NO_CONTEXT) => {
      const { slug, cardId, note } = AdaptPayload.parse(job.payload);
      return adaptJob(slug, cardId, note, ctx);
    },

    "card.storyboard": async (job, ctx = NO_CONTEXT) => {
      const { slug, cardId } = CardPayload.parse(job.payload);
      const card = await repo.getCard(slug, cardId);
      if (!card) throw new Error(`no card ${cardId}`);
      if (!(await repo.getScript(slug, cardId))) throw new Error(`card ${cardId} has no script yet`);
      const result = await deps.ops.storyboardCard({ storage, costSink: deps.costSinkFor(slug), report: ctx.report }, slug, cardId, card.sourceId);
      // A shot or two failing is reported on the board and can be redone; every
      // one failing means something is wrong with the run itself.
      if (result.failed.length > 0 && result.generated.length === 0) throw new Error(`no still could be generated: ${result.failed[0]}`);
      return { generated: result.generated.length, failed: result.failed.length };
    },

    "plan.build": async (job, ctx = NO_CONTEXT) => {
      const { slug, days } = BuildPayload.parse(job.payload);
      const costSink = deps.costSinkFor(slug);
      ctx.report({ stage: "Reading your brand" });

      const brand = await repo.getBrand(slug);
      const intake = await repo.getIntake(slug);
      if (!intake) throw new Error(`${slug} has no intake`);
      const product = intake.products[intake.recommendedProductIndex] ?? intake.products[0];
      const niche = await repo.getNiche(slug);
      const chosen = niche?.angles.find((a) => a.id === niche.chosenAngleId) ?? null;

      const pool: PoolSource[] = [];
      for (const s of await repo.listSources(slug)) {
        const spec = s.hasSpec ? await repo.getSpec(slug, s.sourceId) : null;
        if (spec) pool.push({ sourceId: s.sourceId, topic: spec.topic, hook: spec.hook, whyItWorks: spec.whyItWorks, durationSec: spec.media.durationSec, language: spec.language });
      }
      if (pool.length === 0) throw new Error("there are no viral sources to plan from yet: add some first");

      const existing = await readPlan(storage, slug);
      const taken = new Set(existing?.cards.map((c) => c.day) ?? []);
      const target = days ?? CYCLE_DAYS;
      const freeDays = Array.from({ length: target }, (_, i) => i + 1).filter((d) => !taken.has(d));
      if (freeDays.length === 0) return { added: 0 };

      ctx.report({ stage: "Choosing the videos", message: `${freeDays.length} days to fill from ${pool.length} formats` });
      const proposal = await deps.proposer(costSink, `${slug}/plan`)({
        company: intake.companyName,
        product: { name: product.name, oneLiner: product.oneLiner, features: product.features },
        audience: brand.audience ?? intake.audience,
        language: brand.language,
        niche: chosen ? { title: chosen.title, whyItFits: chosen.whyItFits } : null,
        sources: pool,
        freeDays,
        existing: (existing?.cards ?? []).map((c) => ({ day: c.day, sourceId: c.sourceId, angle: c.angle })),
      });

      const all = [...(existing?.cards ?? []).map((c) => ({ day: c.day, sourceId: c.sourceId })), ...proposal.cards.map((c) => ({ day: c.day, sourceId: c.sourceId }))];
      const alternates = pickAlternates(all, pool);
      const cards: Card[] = proposal.cards
        .sort((a, b) => a.day - b.day)
        .map((c) => ({
          id: `${c.sourceId}-d${c.day}`,
          day: c.day,
          sourceId: c.sourceId,
          angle: c.angle,
          hook: "",
          status: "draft" as const,
          lowConfidence: false,
          alternates: (alternates.get(c.day) ?? []).map((sourceId) => ({ sourceId, angle: "" })),
          history: [],
        }));

      // Day 1 is tomorrow in the brand's own calendar, unless a plan already fixed it.
      const startsOn = existing?.startsOn ?? addDays(todayIn(brand.timezone), 1);
      if (existing) await updatePlan(storage, slug, (plan) => ({ ...plan, cards: [...plan.cards, ...cards] }));
      else await savePlan(storage, slug, { cycleId: "c1", startsOn, niche: chosen ? { angleId: chosen.id, title: chosen.title } : null, cards });

      // Each new card gets its script as its own job, so one failing does not
      // hold up the others and the page can show them arriving.
      for (const card of cards) {
        await queue.enqueue("card.adapt", { slug, cardId: card.id }, { dedupeKey: `card.adapt:${taskDedupeKey({ slug, cardId: card.id })}` });
      }
      ctx.report({ stage: "Plan ready", done: cards.length, total: cards.length });
      return { added: cards.length };
    },
  };
};

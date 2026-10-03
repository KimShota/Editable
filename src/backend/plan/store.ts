import { brandKeys, recreationKeys } from "../brand/keys";
import type { Storage } from "../storage";
import { readJsonIfExists, writeJson } from "../storageJson";
import { type Actor, type Card, type CardStatus, type Niche, NicheSchema, type Plan, PlanSchema } from "./schemas";
import { transitionCard } from "./status";

/**
 * Reads and writes `brands/<slug>/plan.json` and `niche.json` through the
 * Storage seam (so a test can point it at a temp directory).
 *
 * plan.json is read-modify-written by the app (customer actions) and by the
 * worker (status changes as production runs), which are separate processes.
 * `updatePlan` serialises writers inside one process with a per-brand
 * queue and bumps `rev` on every write; across processes the window between
 * the read and the write is a few milliseconds, which is acceptable for the
 * pilot. Phase 2 moves this to a row with a real transaction.
 */

export const readPlan = async (storage: Storage, slug: string): Promise<Plan | null> => {
  const raw = await readJsonIfExists(storage, brandKeys(slug).plan);
  return raw === null ? null : PlanSchema.parse(raw);
};

const tails = new Map<string, Promise<unknown>>();

/** Runs `fn` after every earlier writer of this brand's plan has finished. */
const serialised = <T>(slug: string, fn: () => Promise<T>): Promise<T> => {
  const prev = tails.get(slug) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // The queue only needs to know when this one settles, not how.
  tails.set(
    slug,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
};

/** Applies `fn` to the current plan and saves the result (rev + 1). `fn`
 *  may return a new plan or mutate and return the one it was given; it must
 *  not do I/O of its own. Throws if the brand has no plan yet. */
export const updatePlan = (storage: Storage, slug: string, fn: (plan: Plan) => Plan): Promise<Plan> =>
  serialised(slug, async () => {
    const current = await readPlan(storage, slug);
    if (!current) throw new Error(`brand ${slug} has no plan yet`);
    const next = PlanSchema.parse({ ...fn(structuredClone(current)), rev: current.rev + 1 });
    await writeJson(storage, brandKeys(slug).plan, next);
    return next;
  });

/** Creates a plan, or replaces an existing one (rev continues from it). */
export const savePlan = (storage: Storage, slug: string, plan: Omit<Plan, "rev"> & { rev?: number }): Promise<Plan> =>
  serialised(slug, async () => {
    const current = await readPlan(storage, slug);
    const next = PlanSchema.parse({ ...plan, rev: (current?.rev ?? -1) + 1 });
    await writeJson(storage, brandKeys(slug).plan, next);
    return next;
  });

export const findCard = (plan: Plan, cardId: string): Card => {
  const card = plan.cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`no card ${cardId} in the plan`);
  return card;
};

/** Moves one card to `to` (see status.ts for who may do what). */
export const transitionCardInPlan = (
  storage: Storage,
  slug: string,
  cardId: string,
  to: CardStatus,
  actor: Actor,
  patch: Partial<Pick<Card, "lowConfidence" | "estimateUsd" | "estimateMaxUsd" | "thumbsDown">> = {},
): Promise<Plan> =>
  updatePlan(storage, slug, (plan) => {
    // A move for a card that is not in the plan is a bug in the caller, not
    // a no-op: findCard throws.
    findCard(plan, cardId);
    return { ...plan, cards: plan.cards.map((c) => (c.id === cardId ? { ...transitionCard(c, to, actor), ...patch } : c)) };
  });

/** The viral source whose spec backs a card. Before cards existed a script
 *  was keyed by its source id, so a card with no entry in the plan is its
 *  own source. */
export const sourceIdForCard = async (storage: Storage, slug: string, cardId: string): Promise<string> => {
  const plan = await readPlan(storage, slug);
  return plan?.cards.find((c) => c.id === cardId)?.sourceId ?? cardId;
};

export const readNiche = async (storage: Storage, slug: string): Promise<Niche | null> => {
  const raw = await readJsonIfExists(storage, brandKeys(slug).niche);
  return raw === null ? null : NicheSchema.parse(raw);
};

export const saveNiche = async (storage: Storage, slug: string, niche: Niche): Promise<void> => {
  await writeJson(storage, brandKeys(slug).niche, NicheSchema.parse(niche));
};

/** The ids of every downloaded source in a brand's pool. */
export const listSourceIds = async (storage: Storage, slug: string): Promise<string[]> => {
  const k = recreationKeys(slug);
  return (await storage.list(k.root))
    .filter((f) => /\/[^/]+\.mp4$/.test(f) && !f.includes("/keyframes/"))
    .map((f) => f.split("/").pop()!.replace(/\.mp4$/, ""));
};

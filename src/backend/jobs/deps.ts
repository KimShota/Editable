import type { QueryFn } from "../../app/lib/db";
import { type CostSink, dbSink } from "../cost/ledger";
import type { ProposerFactory } from "../plan/propose";
import type { TaskProgress } from "../queue/workQueue";
import type { AdaptOptions } from "../recreation/adapt";
import type { AdaptedScript, RecreationSpec } from "../recreation/schemas";
import type { StoryboardOptions, StoryboardResult } from "../recreation/ops";
import type { Storage } from "../storage";

/**
 * Everything a job handler needs from the outside world, in one object, so a
 * test (or a demo with no API keys) can swap the paid parts for stubs:
 * `KATALAB_STUB_PROVIDERS=1` selects jobs/stubs.ts instead of the real ones
 * (jobs/registry.ts). Handlers touch storage, the database and these
 * functions, and nothing else.
 */

export type OpContext = {
  storage: Storage;
  costSink: CostSink;
  report?: (progress: TaskProgress) => void;
};

export type RecreationOps = {
  ingestSource: (storage: Storage, slug: string, url: string) => Promise<string>;
  buildSpec: (ctx: OpContext, slug: string, sourceId: string) => Promise<RecreationSpec>;
  adaptCard: (ctx: OpContext, slug: string, cardId: string, sourceId: string, opts?: AdaptOptions) => Promise<AdaptedScript>;
  storyboardCard: (ctx: OpContext, slug: string, cardId: string, sourceId: string, opts?: StoryboardOptions) => Promise<StoryboardResult>;
};

export type JobDeps = {
  query: QueryFn;
  storage: Storage;
  ops: RecreationOps;
  proposer: ProposerFactory;
  /** Records paid calls against the brand in cost_ledger. */
  costSinkFor: (slug: string) => CostSink;
};

/** A cost sink that files each entry under the brand with this slug. The
 *  brand's id is looked up once per sink. */
export const brandCostSink = (query: QueryFn, slug: string): CostSink => {
  let brandId: Promise<string | null> | undefined;
  const sink = dbSink(query);
  return async (entry) => {
    brandId ??= query(`select id from brands where slug = $1`, [slug]).then((r) => (r[0] ? String(r[0].id) : null));
    await sink({ ...entry, brandId: entry.brandId ?? (await brandId) });
  };
};

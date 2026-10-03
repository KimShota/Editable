import fs from "node:fs";
import type { QueryFn } from "../../app/lib/db";
import { LockedCharacterSchema, type LockedCharacter } from "../character/schemas";
import { type Actor, type Card, type CardStatus, type Niche, type Plan, type PostDetails, PostDetailsSchema } from "../plan/schemas";
import { findCard, listSourceIds, readNiche, readPlan, savePlan, transitionCardInPlan, updatePlan } from "../plan/store";
import { AdaptedScriptSchema, type AdaptedScript, RecreationSpecSchema, type RecreationSpec } from "../recreation/schemas";
import type { Storage } from "../storage";
import { readJsonIfExists, writeJson } from "../storageJson";
import { type BrandRef, findBrandForViewer, listBrandsForViewer, type Viewer } from "./access";
import { type BrandIntake, BrandIntakeSchema } from "./intake/schemas";
import { brandKeys, characterKeys, productionKeys, recreationKeys } from "./keys";

/**
 * The only door to a brand's state (plan/ui-ux-full-flow.md §2.1). Every
 * page, route handler and job handler goes through this; no screen reads a
 * storage key itself. Phase 1 backs it with the files the CLIs write plus the
 * workspace/brand rows that say who may see them; Phase 2 moves the files
 * into tables behind the same methods.
 *
 * Takes `query` and `storage` so checks run it on PGlite and a temp
 * directory. `src/app/lib/brandRepo.ts` is the production instance.
 */

export type { BrandRef, Viewer };

/** A viewer asked for a brand they cannot see, or one that does not exist.
 *  Both are reported the same way so a slug can't be probed. */
export class BrandAccessError extends Error {
  constructor(slug: string) {
    super(`no brand "${slug}"`);
    this.name = "BrandAccessError";
  }
}

export type SourceSummary = {
  sourceId: string;
  url: string | null;
  creator: string | null;
  views: number | null;
  likes: number | null;
  durationSec: number | null;
  shotCount: number | null;
  hook: string | null;
  whyItWorks: string | null;
  /** Storage key of the contact-sheet thumbnail, if there is one. */
  thumbKey: string | null;
  hasSpec: boolean;
};

export type StoryboardStill = { shotId: string; key: string };

export type VideoSummary = {
  cardId: string;
  hasFinal: boolean;
  finalKey: string | null;
  hasEdl: boolean;
  /** Everything paid for this video so far, from its costs.jsonl. */
  costUsd: number;
};

const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

export class BrandRepo {
  constructor(
    private readonly query: QueryFn,
    private readonly storage: Storage,
  ) {}

  // ---- who can see what ---------------------------------------------------

  /** The brands a viewer may open, oldest first. Only brands linked to files
   *  (a slug) are listed. */
  listBrandsForUser(viewer: Viewer): Promise<BrandRef[]> {
    return listBrandsForViewer(this.query, viewer);
  }

  /** The brand's row, or throws BrandAccessError if the viewer may not see it. */
  async assertAccess(viewer: Viewer, slug: string): Promise<BrandRef> {
    const brand = await findBrandForViewer(this.query, viewer, slug);
    if (!brand) throw new BrandAccessError(slug);
    return brand;
  }

  /** Every slug that has a brand row: the middleware's allow-list for
   *  deciding whether a /api/media/brands/<slug>/ path names a real brand. */
  async hasBrand(slug: string): Promise<boolean> {
    return (await this.query(`select 1 from brands where slug = $1`, [slug])).length > 0;
  }

  /** The members of a brand's workspace. */
  async listMembers(slug: string): Promise<{ userId: string; email: string }[]> {
    const rows = await this.query(
      `select u.id, u.email
         from brands b
         join workspace_members m on m.workspace_id = b.workspace_id
         join users u on u.id = m.user_id
        where b.slug = $1 order by m.created_at`,
      [slug],
    );
    return rows.map((r) => ({ userId: String(r.id), email: String(r.email) }));
  }

  // ---- brand, character, niche -------------------------------------------

  async getBrand(slug: string) {
    const rows = await this.query(
      `select id, name, website_url, language, audience, tone, post_time, timezone, workspace_id from brands where slug = $1`,
      [slug],
    );
    if (rows.length === 0) throw new BrandAccessError(slug);
    const r = rows[0];
    return {
      brandId: String(r.id),
      slug,
      name: String(r.name),
      websiteUrl: (r.website_url as string | null) ?? null,
      language: String(r.language),
      audience: (r.audience as string | null) ?? null,
      tone: (r.tone as string[]) ?? [],
      postTime: String(r.post_time).slice(0, 5),
      timezone: String(r.timezone),
      workspaceId: String(r.workspace_id),
    };
  }

  async getIntake(slug: string): Promise<BrandIntake | null> {
    const raw = await readJsonIfExists(this.storage, brandKeys(slug).intake);
    if (raw === null) return null;
    // intake.json is either the bare intake or {intake, …} (see character cli).
    return BrandIntakeSchema.parse(asObject(raw).intake ?? raw);
  }

  async getCharacter(slug: string): Promise<LockedCharacter | null> {
    const raw = await readJsonIfExists(this.storage, characterKeys(slug).character);
    return raw === null ? null : LockedCharacterSchema.parse(raw);
  }

  async getNiche(slug: string): Promise<Niche | null> {
    return readNiche(this.storage, slug);
  }

  // ---- sources and specs --------------------------------------------------

  async listSources(slug: string): Promise<SourceSummary[]> {
    const k = recreationKeys(slug);
    const out: SourceSummary[] = [];
    for (const sourceId of await listSourceIds(this.storage, slug)) {
      const info = asObject(await readJsonIfExists(this.storage, k.info(sourceId)));
      const specRaw = await readJsonIfExists(this.storage, k.spec(sourceId));
      const spec = specRaw === null ? null : RecreationSpecSchema.parse(specRaw);
      out.push({
        sourceId,
        url: spec?.sourceUrl ?? (info.webpage_url as string | undefined) ?? null,
        creator: spec?.creator ?? (info.uploader as string | undefined) ?? (info.channel as string | undefined) ?? null,
        views: spec?.engagement.views ?? num(info.view_count),
        likes: spec?.engagement.likes ?? num(info.like_count),
        durationSec: spec?.media.durationSec ?? null,
        shotCount: spec?.shots.length ?? null,
        hook: spec?.hook ?? null,
        whyItWorks: spec?.whyItWorks ?? null,
        thumbKey: (await this.storage.exists(k.sheet(sourceId))) ? k.sheet(sourceId) : null,
        hasSpec: spec !== null,
      });
    }
    return out;
  }

  async getSpec(slug: string, sourceId: string): Promise<RecreationSpec | null> {
    const raw = await readJsonIfExists(this.storage, recreationKeys(slug).spec(sourceId));
    return raw === null ? null : RecreationSpecSchema.parse(raw);
  }

  // ---- the plan and its cards --------------------------------------------

  getPlan(slug: string): Promise<Plan | null> {
    return readPlan(this.storage, slug);
  }

  savePlan(slug: string, plan: Omit<Plan, "rev"> & { rev?: number }): Promise<Plan> {
    return savePlan(this.storage, slug, plan);
  }

  updatePlan(slug: string, fn: (plan: Plan) => Plan): Promise<Plan> {
    return updatePlan(this.storage, slug, fn);
  }

  async getCard(slug: string, cardId: string): Promise<Card | null> {
    const plan = await readPlan(this.storage, slug);
    return plan?.cards.find((c) => c.id === cardId) ?? null;
  }

  /** Moves a card between statuses; status.ts decides who may. */
  transitionCard(
    slug: string,
    cardId: string,
    to: CardStatus,
    actor: Actor,
    patch?: Parameters<typeof transitionCardInPlan>[5],
  ): Promise<Plan> {
    return transitionCardInPlan(this.storage, slug, cardId, to, actor, patch);
  }

  async getScript(slug: string, cardId: string): Promise<AdaptedScript | null> {
    const raw = await readJsonIfExists(this.storage, recreationKeys(slug).script(cardId));
    return raw === null ? null : AdaptedScriptSchema.parse(raw);
  }

  async saveScript(slug: string, cardId: string, script: AdaptedScript): Promise<void> {
    await writeJson(this.storage, recreationKeys(slug).script(cardId), AdaptedScriptSchema.parse(script));
  }

  /** The storyboard stills generated so far for a card (shots that reuse a
   *  product-footage frame have no still of their own). */
  async listStoryboard(slug: string, cardId: string): Promise<StoryboardStill[]> {
    const dir = recreationKeys(slug).board(cardId);
    const keys = await this.storage.list(dir);
    return keys
      .map((key) => ({ key, name: key.slice(dir.length + 1) }))
      .filter((f) => /^[^/]+\.png$/.test(f.name))
      .map((f) => ({ shotId: f.name.replace(/\.png$/, ""), key: f.key }));
  }

  // ---- a produced video ---------------------------------------------------

  async getVideo(slug: string, cardId: string): Promise<VideoSummary> {
    const k = productionKeys(slug, cardId);
    let costUsd = 0;
    if (await this.storage.exists(k.costs)) {
      for (const line of fs.readFileSync(await this.storage.localPath(k.costs), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          costUsd += num(JSON.parse(line).usd) ?? 0;
        } catch {
          // A half-written trailing line must not hide the rest of the costs.
        }
      }
    }
    const hasFinal = await this.storage.exists(k.final);
    return { cardId, hasFinal, finalKey: hasFinal ? k.final : null, hasEdl: await this.storage.exists(k.edl), costUsd };
  }

  async getPostDetails(slug: string, cardId: string): Promise<PostDetails> {
    const raw = await readJsonIfExists(this.storage, productionKeys(slug, cardId).post);
    return PostDetailsSchema.parse(raw ?? {});
  }

  async savePostDetails(slug: string, cardId: string, details: PostDetails): Promise<PostDetails> {
    // The card must exist: a caption for a day that is not in the plan is a bug.
    const plan = await readPlan(this.storage, slug);
    if (!plan) throw new Error(`brand ${slug} has no plan yet`);
    findCard(plan, cardId);
    const parsed = PostDetailsSchema.parse(details);
    await writeJson(this.storage, productionKeys(slug, cardId).post, parsed);
    return parsed;
  }
}

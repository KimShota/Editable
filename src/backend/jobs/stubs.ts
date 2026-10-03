import { recreationKeys } from "../brand/keys";
import { fixtureScript, fixtureSpec } from "../tools/fixtures/specFixture";
import { sourceIdFromUrl } from "../recreation/decompose";
import { parseViralUrl } from "../recreation/viralUrl";
import { type Proposal, type ProposerFactory, proposalProblems } from "../plan/propose";
import { writeJson } from "../storageJson";
import type { JobDeps, RecreationOps } from "./deps";

/**
 * The paid parts of the recreation pipeline, replaced by deterministic
 * stand-ins that write the same files (valid against the real schemas) in
 * milliseconds. Selected by KATALAB_STUB_PROVIDERS=1: the browser tests, and
 * a demo with no API keys. Never used otherwise.
 */

// 1x1 PNG: a real image the browser can decode, whatever the extension says.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const stubOps = (stepMs = 150): RecreationOps => ({
  ingestSource: async (storage, slug, url) => {
    const k = recreationKeys(slug);
    const id = sourceIdFromUrl(parseViralUrl(url));
    await pause(stepMs);
    await storage.putBuffer(k.video(id), Buffer.alloc(2048, 7));
    await storage.putBuffer(k.info(id), Buffer.from(JSON.stringify({ webpage_url: url, uploader: "stub creator", view_count: 4242, like_count: 99 })));
    await storage.putBuffer(k.sheet(id), PNG);
    return id;
  },

  buildSpec: async ({ storage, report }, slug, id) => {
    const k = recreationKeys(slug);
    report?.({ stage: "Understanding how it works" });
    await pause(stepMs);
    const spec = fixtureSpec(id, { brand: slug });
    for (const shot of spec.shots) for (const kf of shot.keyframes) await storage.putBuffer(kf.key, PNG);
    await writeJson(storage, k.spec(id), spec);
    return spec;
  },

  adaptCard: async ({ storage, report }, slug, cardId, sourceId, opts = {}) => {
    const k = recreationKeys(slug);
    report?.({ stage: "Writing the script" });
    await pause(stepMs);
    const note = opts.direction ? ` [${opts.direction.replace(/\s+/g, " ").slice(-60)}]` : "";
    const script = fixtureScript(slug, sourceId, {
      angle: opts.direction?.slice(0, 120) || `An angle for ${cardId}`,
      lines: [`Hook for ${cardId}${note}: here is what I wish I knew.`, `Open it and it handles the busywork for ${cardId}.`, "Comment GO and I will send you the guide."],
    });
    await writeJson(storage, k.script(cardId), script);
    return script;
  },

  storyboardCard: async ({ storage, report }, slug, cardId, sourceId, opts = {}) => {
    const k = recreationKeys(slug);
    const script = fixtureScript(slug, sourceId);
    const dir = k.board(cardId);
    const generated: string[] = [];
    const shots = script.shots.map((s) => s.shotId).filter((id) => !opts.shots || opts.shots.includes(id));
    report?.({ stage: "Generating stills", done: 0, total: shots.length });
    for (const [i, shotId] of shots.entries()) {
      await pause(stepMs);
      if (opts.redo || !(await storage.exists(`${dir}/${shotId}.png`))) {
        await storage.putBuffer(`${dir}/${shotId}.png`, PNG);
        generated.push(shotId);
      }
      report?.({ stage: "Generating stills", done: i + 1, total: shots.length, message: shotId });
    }
    await storage.putBuffer(`${dir}/board.html`, Buffer.from("<html><body>stub board</body></html>"));
    return { generated, failed: [], footageShots: 0, boardKey: `${dir}/board.html` };
  },
});

/** Round-robin over the pool, never repeating a source next to itself. */
export const stubProposer: ProposerFactory = () => async (input): Promise<Proposal> => {
  const uses = new Map(input.sources.map((s) => [s.sourceId, 0]));
  const bySourceDay = new Map(input.existing.map((e) => [e.day, e.sourceId]));
  for (const e of input.existing) uses.set(e.sourceId, (uses.get(e.sourceId) ?? 0) + 1);
  const cards: Proposal["cards"] = [];
  for (const day of [...input.freeDays].sort((a, b) => a - b)) {
    const next = [...input.sources]
      .filter((s) => input.sources.length === 1 || (bySourceDay.get(day - 1) !== s.sourceId && bySourceDay.get(day + 1) !== s.sourceId))
      .sort((a, b) => (uses.get(a.sourceId) ?? 0) - (uses.get(b.sourceId) ?? 0) || a.sourceId.localeCompare(b.sourceId))[0];
    uses.set(next.sourceId, (uses.get(next.sourceId) ?? 0) + 1);
    bySourceDay.set(day, next.sourceId);
    cards.push({ day, sourceId: next.sourceId, angle: `${input.product.name}: angle for day ${day}${input.niche ? ` (${input.niche.title})` : ""}` });
  }
  const problems = proposalProblems(input, { cards });
  if (problems.length) throw new Error(`stub proposer made a bad plan: ${problems.join("; ")}`);
  return { cards };
};

export const stubDeps = (base: Pick<JobDeps, "query" | "storage" | "costSinkFor">): JobDeps => ({ ...base, ops: stubOps(), proposer: stubProposer });

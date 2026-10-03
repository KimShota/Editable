import { productionKeys, recreationKeys } from "../brand/keys";
import { AdaptedScriptSchema } from "../recreation/schemas";
import type { Storage } from "../storage";
import { readJson } from "../storageJson";
import { type Card, CYCLE_DAYS, type Plan } from "./schemas";
import { readNiche } from "./store";

/**
 * Builds a brand's first plan from the files the CLIs already produced
 * (plan/ui-ux-full-flow.md §2.2): one card per adapted script, the card id
 * being the source id the script was written for.
 *
 * A card whose video is already rendered starts in `internal_review`, not
 * `needs_review`: the founder decides when the customer first sees it (the
 * review gate). Everything else is a `draft` waiting for the customer.
 */
export const planFromFiles = async (storage: Storage, slug: string, opts: { startsOn: string; cycleId?: string }): Promise<Omit<Plan, "rev">> => {
  const k = recreationKeys(slug);
  const scriptKeys = (await storage.list(`${k.root.replace(/\/sources$/, "")}/scripts`)).filter((f) => /\/[^/]+\.json$/.test(f));

  const cards: Omit<Card, "day">[] = [];
  for (const key of scriptKeys) {
    const id = key.split("/").pop()!.replace(/\.json$/, "");
    const script = AdaptedScriptSchema.parse(await readJson(storage, key, "adapted script"));
    const rendered = await storage.exists(productionKeys(slug, id).final);
    cards.push({
      id,
      sourceId: script.sourceId,
      angle: script.angle,
      hook: script.lines[0]?.text ?? "",
      status: rendered ? "internal_review" : "draft",
      lowConfidence: false,
      alternates: [],
      history: [],
    });
  }
  if (cards.length === 0) throw new Error(`brand ${slug} has no adapted scripts to build a plan from`);
  if (cards.length > CYCLE_DAYS) throw new Error(`brand ${slug} has ${cards.length} scripts; a cycle holds ${CYCLE_DAYS}`);

  // Finished videos first (they are the ones to show), then by id.
  cards.sort((a, b) => Number(b.status === "internal_review") - Number(a.status === "internal_review") || a.id.localeCompare(b.id));

  const niche = await readNiche(storage, slug);
  const chosen = niche?.angles.find((a) => a.id === niche.chosenAngleId) ?? null;
  return {
    cycleId: opts.cycleId ?? "c1",
    startsOn: opts.startsOn,
    niche: chosen ? { angleId: chosen.id, title: chosen.title } : null,
    cards: cards.map((c, i) => ({ ...c, day: i + 1 })),
  };
};

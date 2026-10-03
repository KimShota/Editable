import { BrandIntakeSchema } from "../brand/intake/schemas";
import { brandKeys } from "../brand/keys";
import { readPlan, readNiche, saveNiche } from "../plan/store";
import type { Storage } from "../storage";
import { readJson } from "../storageJson";
import { type NicheProposer, withIds } from "./propose";

/**
 * Asks for the brand's content angles and saves them as niche.json. Shared
 * by the `niche.propose` job and `npm run niche`. Proposing again replaces
 * the angles and keeps the customer's pick only if it is still among them;
 * once a plan carries a niche it is locked for the cycle, so this refuses.
 */
export const proposeNiche = async (storage: Storage, slug: string, proposer: NicheProposer, report?: (stage: string) => void): Promise<number> => {
  const raw = (await readJson(storage, brandKeys(slug).intake, "brand intake")) as { intake?: unknown };
  const intake = BrandIntakeSchema.parse(raw.intake ?? raw);
  const plan = await readPlan(storage, slug);
  if (plan?.niche) throw new Error(`the niche is locked for this cycle ("${plan.niche.title}")`);

  report?.("Looking at your product");
  const angles = withIds(await proposer(intake));
  const before = await readNiche(storage, slug);
  await saveNiche(storage, slug, {
    angles,
    chosenAngleId: before?.chosenAngleId && angles.some((a) => a.id === before.chosenAngleId) ? before.chosenAngleId : null,
    proposedAt: new Date().toISOString(),
  });
  return angles.length;
};

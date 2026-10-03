import type { Storage } from "../storage";
import { readNiche, readPlan, saveNiche, updatePlan } from "../plan/store";

/**
 * Picking the angle a cycle is about (plan decision 4). The niche is locked
 * for the 14-day cycle: once a plan carries one it cannot change until the
 * next cycle, but picking the same angle again is harmless. Picking before
 * a plan exists just records the choice, and a plan built or seeded later
 * picks it up.
 */

export class NicheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NicheError";
  }
}

export const chooseNiche = async (storage: Storage, slug: string, angleId: string): Promise<{ angleId: string; title: string }> => {
  const niche = await readNiche(storage, slug);
  if (!niche) throw new NicheError("There are no angles to choose from yet.");
  const angle = niche.angles.find((a) => a.id === angleId);
  if (!angle) throw new NicheError("That is not one of the proposed angles.");

  const plan = await readPlan(storage, slug);
  if (plan?.niche && plan.niche.angleId !== angleId) {
    throw new NicheError(`The angle is locked for this cycle ("${plan.niche.title}"). It can change when the next cycle starts.`);
  }

  await saveNiche(storage, slug, { ...niche, chosenAngleId: angleId });
  if (plan && !plan.niche) await updatePlan(storage, slug, (p) => ({ ...p, niche: { angleId: angle.id, title: angle.title } }));
  return { angleId: angle.id, title: angle.title };
};

import "dotenv/config";
import { readPlan, savePlan } from "./store";
import { planFromFiles } from "./seed";
import { assertBrandSlug } from "../brand/keys";
import { getStorage } from "../storage";

/**
 * The brand's plan, from the command line.
 *
 *   npm run plan -- init --brand <slug> [--starts-on YYYY-MM-DD] [--force]
 *   npm run plan -- show --brand <slug>
 *
 * `init` builds plan.json from the adapted scripts already on disk: one card
 * per script, finished videos first. It refuses to replace an existing plan
 * unless --force, because a plan holds the customer's approvals.
 */

const args = process.argv.slice(2);
const [command] = args;
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

/** The day after tomorrow in the local calendar: far enough ahead that the
 *  first cards are not already "today" when the plan is reviewed. */
const defaultStart = (): string => {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const main = async () => {
  const slug = assertBrandSlug(option("--brand") ?? "", "--brand");
  const storage = getStorage();
  if (command === "init") {
    const existing = await readPlan(storage, slug);
    if (existing && !args.includes("--force")) {
      throw new Error(`${slug} already has a plan (${existing.cards.length} cards, rev ${existing.rev}); pass --force to replace it`);
    }
    const plan = await savePlan(storage, slug, await planFromFiles(storage, slug, { startsOn: option("--starts-on") ?? defaultStart() }));
    console.log(`saved plan for ${slug}: cycle ${plan.cycleId} from ${plan.startsOn}, ${plan.cards.length} cards`);
  } else if (command !== "show") {
    throw new Error("usage: npm run plan -- <init|show> --brand <slug> [--starts-on YYYY-MM-DD] [--force]");
  }
  const plan = await readPlan(storage, slug);
  if (!plan) return console.log(`${slug} has no plan yet`);
  console.log(`\ncycle ${plan.cycleId} · starts ${plan.startsOn} · niche ${plan.niche?.title ?? "(none)"} · rev ${plan.rev}`);
  for (const c of plan.cards) console.log(`  day ${String(c.day).padStart(2)}  ${c.id.padEnd(14)} ${c.status.padEnd(16)} ${c.hook.slice(0, 60)}`);
};

main().catch((err) => {
  console.error("plan failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

import "dotenv/config";
import { assertBrandSlug } from "../brand/keys";
import { consoleSink } from "../cost/ledger";
import { readNiche } from "../plan/store";
import { getStorage } from "../storage";
import { chooseNiche } from "./choose";
import { proposeNiche } from "./ops";
import { claudeNicheProposer } from "./propose";

/**
 * A brand's content angles, from the command line.
 *
 *   npm run niche -- propose --brand <slug>          asks Claude (a few cents) and saves niche.json
 *   npm run niche -- choose  --brand <slug> --angle <id>
 *   npm run niche -- show    --brand <slug>
 */

const args = process.argv.slice(2);
const [command] = args;
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const show = async (slug: string) => {
  const niche = await readNiche(getStorage(), slug);
  if (!niche) return console.log(`${slug} has no niche yet`);
  for (const a of niche.angles) {
    console.log(`\n${a.id === niche.chosenAngleId ? "▸" : " "} ${a.id}: ${a.title}\n    ${a.whyItFits}`);
    for (const h of a.exampleHooks) console.log(`    "${h}"`);
  }
  console.log(`\nchosen: ${niche.chosenAngleId ?? "(none)"}`);
};

const main = async () => {
  const slug = assertBrandSlug(option("--brand") ?? "", "--brand");
  const storage = getStorage();
  if (command === "propose") {
    const n = await proposeNiche(storage, slug, claudeNicheProposer({ costSink: consoleSink, ref: `${slug}/niche` }), (s) => console.log(s));
    console.log(`saved ${n} angles`);
  } else if (command === "choose") {
    const angle = option("--angle");
    if (!angle) throw new Error("missing --angle");
    const chosen = await chooseNiche(storage, slug, angle);
    console.log(`chosen: ${chosen.title}`);
  } else if (command !== "show") {
    throw new Error("usage: npm run niche -- <propose|choose|show> --brand <slug> [--angle <id>]");
  }
  await show(slug);
};

main().catch((err) => {
  console.error("niche failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

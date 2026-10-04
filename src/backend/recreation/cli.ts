import path from "node:path";
import "dotenv/config";
import fs from "node:fs";
import { consoleSink } from "../cost/ledger";
import { getStorage } from "../storage";
import { recreationKeys } from "../brand/keys";
import { sourceIdForCard } from "../plan/store";
import { sourceIdFromUrl } from "./decompose";
import { adaptCard, buildSpec, ingestSource, storyboardCard } from "./ops";
import { type AdaptedScript, AdaptedScriptSchema, type RecreationSpec, RecreationSpecSchema } from "./schemas";

/**
 * Viral source videos → RecreationSpecs, run by hand in the pilot (M1 day 3).
 * State is files under storage key brands/<brand>/sources/:
 *
 *   <id>.mp4, <id>.info.json      the downloaded source (yt-dlp)
 *   analysis/<id>.json            the analyzer's measurements
 *   keyframes/<id>/s<i>-<k>.jpg   composition references per shot
 *   specs/<id>.json               the RecreationSpec
 *
 * and, per brand, brands/<brand>/scripts/<id>.json: the spec rewritten for the
 * brand's product and character (day 4), from brands/<brand>/intake.json,
 * character/character.json and product/footage.json.
 *
 *   npm run recreate -- ingest --brand <slug> --url <url> [--url <url> …]
 *   npm run recreate -- spec   --brand <slug> [--source <id>]     (all downloaded sources when omitted)
 *   npm run recreate -- show   --brand <slug> [--source <id>]
 *   npm run recreate -- adapt  --brand <slug> [--source <id> | --card <id>] [--keep 0,3] [--cta WORD] [--direction "…"]
 *   npm run recreate -- script --brand <slug> [--source <id>]     (print adapted scripts)
 *   npm run recreate -- storyboard --brand <slug> --source <id> | --card <id> [--shots s0,s3] [--redo] [--set "…"] [--screen-ref <image>]
 */

const USAGE = "usage: npm run recreate -- <ingest|spec|show|adapt|script|storyboard> --brand <slug> [options]  (see cli.ts)";

const option = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const options = (args: string[], name: string): string[] => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const required = (args: string[], name: string): string => {
  const v = option(args, name);
  if (!v) throw new Error(`missing ${name}\n${USAGE}`);
  return v;
};

const storage = getStorage();

const keys = recreationKeys;

const sourceIds = async (brand: string, only?: string): Promise<string[]> => {
  if (only) return [only];
  const k = keys(brand);
  return (await storage.list(k.root)).filter((f) => /\/[^/]+\.mp4$/.test(f) && !f.includes("/keyframes/")).map((f) => f.split("/").pop()!.replace(/\.mp4$/, ""));
};

const readJson = async (key: string, what: string): Promise<unknown> => {
  if (!(await storage.exists(key))) throw new Error(`no ${what} at ${key}`);
  return JSON.parse(fs.readFileSync(await storage.localPath(key), "utf8"));
};

const commands: Record<string, (args: string[]) => Promise<void>> = {
  ingest: async (args) => {
    const brand = required(args, "--brand");
    const urls = options(args, "--url");
    if (urls.length === 0) throw new Error(`missing --url\n${USAGE}`);
    for (const url of urls) {
      try {
        const id = await ingestSource(storage, brand, url);
        console.log(`  ✔ ${id}  ${await storage.localPath(keys(brand).video(id))}`);
      } catch (err) {
        console.log(`  ✘ ${sourceIdFromUrl(url)}: ${err instanceof Error ? err.message : err}`);
      }
    }
  },

  spec: async (args) => {
    const brand = required(args, "--brand");
    for (const id of await sourceIds(brand, option(args, "--source"))) {
      console.log(`\n${id}`);
      const spec = await buildSpec({ storage, costSink: consoleSink, report: (p) => console.log(`  ${p.stage}${p.message ? `: ${p.message}` : ""}`) }, brand, id);
      printSpec(spec);
      console.log(`  saved ${keys(brand).spec(id)}`);
    }
  },

  show: async (args) => {
    const brand = required(args, "--brand");
    const k = keys(brand);
    for (const id of await sourceIds(brand, option(args, "--source"))) {
      if (!(await storage.exists(k.spec(id)))) {
        console.log(`\n${id}: no spec yet`);
        continue;
      }
      printSpec(RecreationSpecSchema.parse(JSON.parse(fs.readFileSync(await storage.localPath(k.spec(id)), "utf8"))));
    }
  },

  adapt: async (args) => {
    const brand = required(args, "--brand");
    const k = keys(brand);
    // --card <id> adapts one plan card: its spec comes from the card's source
    // and its script is saved under the card id (defaults to the source id,
    // so plain --source keeps working).
    const cardArg = option(args, "--card");
    const only = cardArg ?? option(args, "--source");
    const keep = option(args, "--keep")?.split(",").map(Number);
    if (keep && !only) throw new Error("--keep needs --source or --card: line indices differ per source");
    for (const id of await sourceIds(brand, only)) {
      const sourceId = cardArg ? await sourceIdForCard(storage, brand, id) : id;
      if (!(await storage.exists(k.spec(sourceId)))) {
        console.log(`\n${sourceId}: no spec yet, run spec first`);
        continue;
      }
      const script = await adaptCard({ storage, costSink: consoleSink }, brand, id, sourceId, { keep, cta: option(args, "--cta"), direction: option(args, "--direction") });
      printScript(script);
      console.log(`  saved ${k.script(id)}`);
    }
  },

  script: async (args) => {
    const brand = required(args, "--brand");
    const k = keys(brand);
    for (const id of await sourceIds(brand, option(args, "--source"))) {
      if (await storage.exists(k.script(id))) printScript(AdaptedScriptSchema.parse(await readJson(k.script(id), "script")));
    }
  },

  storyboard: async (args) => {
    const brand = required(args, "--brand");
    // --card <id> (or --source <id>, which is its own card): the storyboard is
    // keyed by the card, the spec by the card's source.
    const id = option(args, "--card") ?? required(args, "--source");
    const sourceId = await sourceIdForCard(storage, brand, id);
    const only = option(args, "--shots")?.split(",");
    // --screen-ref <image file>: the composition for screen shots without product footage, a laptop on a table.
    const screenRefFile = option(args, "--screen-ref");
    let screenRefKey: string | undefined;
    if (screenRefFile) {
      screenRefKey = `brands/${brand}/storyboards/${id}/screen-ref${path.extname(screenRefFile).toLowerCase() || ".jpg"}`;
      await storage.putFile(screenRefKey, screenRefFile);
    }
    const result = await storyboardCard(
      { storage, costSink: consoleSink, report: (p) => p.message && console.log(`  ${p.stage}: ${p.message}${p.total ? ` (${p.done}/${p.total})` : ""}`) },
      brand,
      id,
      sourceId,
      { shots: only, redo: args.includes("--redo"), set: option(args, "--set"), screenRefKey },
    );
    console.log(`${result.generated.length} still(s) generated (${result.footageShots} shots use footage frames)`);
    for (const f of result.failed) console.log(`  ✘ ${f}`);
    console.log(`board: ${await storage.localPath(result.boardKey)}${result.failed.length ? `\nfailed: ${result.failed.map((f) => f.split(":")[0]).join(",")} (rerun with --shots ${result.failed.map((f) => f.split(":")[0]).join(",")})` : ""}`);
  },
};

const printScript = (s: AdaptedScript) => {
  console.log(`\n== ${s.sourceId} → ${s.brand} · comment ${s.ctaKeyword}\nangle: ${s.angle}`);
  for (const l of s.lines) console.log(`  [${l.index}] ${l.role.padEnd(7)} ${l.kept ? "(kept) " : ""}"${l.text}"  (${l.wordCount}/${l.sourceWordCount}w)`);
  for (const sh of s.shots) {
    const screen = sh.footageId ? ` ▸ footage ${sh.footageId}` : sh.otherScreen ? ` ▸ screen: ${sh.otherScreen}` : "";
    const text = sh.textOnScreen.map((t) => `"${t.text}"`).join(" ");
    console.log(`  ${sh.shotId.padEnd(4)} ${sh.treatment.padEnd(21)} ${sh.action}${screen}${text ? `  ${text}` : ""}`);
  }
  console.log(`  caption: ${s.postCaption} ${s.hashtags.map((h) => `#${h}`).join(" ")}`);
};

const printSpec = (s: RecreationSpec) => {
  console.log(`\n== ${s.sourceId} · ${s.creator ?? "?"} · ${s.media.durationSec.toFixed(1)}s · ${s.engagement.likes ?? "?"} likes · ${s.engagement.comments ?? "?"} comments`);
  console.log(`topic: ${s.topic}\nhook: ${s.hook}\nwhy: ${s.whyItWorks}`);
  console.log(`beats: ${s.structure.map((b) => `${b.beat}[${b.shotIndices.join(",")}]`).join(" → ")}`);
  console.log(`captions: ${s.captionStyle.mode}, ${s.captionStyle.position}, ${s.captionStyle.look}`);
  for (const sh of s.shots) {
    const text = sh.textOnScreen.map((t) => `"${t.text}"`).join(" ");
    console.log(`  ${sh.id.padEnd(4)} ${sh.startSec.toFixed(1).padStart(5)}–${sh.endSec.toFixed(1).padEnd(5)} ${sh.kind.padEnd(8)} ${sh.speaker.padEnd(10)} ${sh.subject}${text ? `  ${text}` : ""}`);
  }
  for (const l of s.speech.lines) console.log(`    [${l.role}] ${l.startSec.toFixed(1)}s "${l.text}"`);
};

const main = async () => {
  const [command, ...args] = process.argv.slice(2);
  const run = commands[command];
  if (!run) {
    console.error(USAGE);
    process.exit(1);
  }
  await run(args);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

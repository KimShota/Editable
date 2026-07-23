import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AnalysisSchema, DraftSchema, IngestResultSchema } from "./schemas";
import { ingestFromUrl, newDraftId } from "./ingest";
import { analyze } from "./analyze";
import { synthesize } from "./synthesize";
import { authoringDir } from "../pipeline/paths";

/**
 * The format-authoring pipeline's CLI — the analog of pipeline/run.ts, but
 * for reverse-engineering a reference reel into a draft Format instead of
 * assembling a user's own video.
 *
 *   npm run author -- --url <reelUrl> [--draft <draftId>] [--only <stage>]
 *
 * Stages: ingest → analyze → synthesize. Each writes its artifact to
 * authoring/<draftId>/ — same "inspect the artifact, not the video" idea
 * as the render pipeline. --only reruns a single stage against whatever's
 * already on disk (ingest itself is never skippable — it IS the source of
 * the draftId when one isn't given).
 */

const STAGES = ["ingest", "analyze", "synthesize"] as const;
type Stage = (typeof STAGES)[number];

const parseArgs = (argv: string[]) => {
  const args: { url?: string; draft?: string; only?: Stage } = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--url":
        args.url = argv[++i];
        break;
      case "--draft":
        args.draft = argv[++i];
        break;
      case "--only": {
        const stage = argv[++i] as Stage;
        if (!STAGES.includes(stage)) {
          throw new Error(`--only must be one of: ${STAGES.join(", ")}`);
        }
        args.only = stage;
        break;
      }
      default:
        throw new Error(`unknown argument "${argv[i]}"`);
    }
  }
  if (!args.url && !args.draft) {
    throw new Error(
      "usage: npm run author -- --url <reelUrl> [--draft <draftId>] [--only ingest|analyze|synthesize]\n" +
        "  (--draft without --url resumes an existing draft; --only needs an existing --draft)",
    );
  }
  // "ingest" is the entry stage — it CREATES the draft, so `--only ingest`
  // needs no pre-existing --draft. "analyze"/"synthesize" resume from an
  // earlier stage's artifact and have nothing to read without one.
  if (args.only && args.only !== "ingest" && !args.draft) {
    throw new Error(`--only ${args.only} requires --draft <draftId> (nothing to resume from otherwise)`);
  }
  return args;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const draftId = args.draft ?? newDraftId();
  const dir = authoringDir(draftId);
  fs.mkdirSync(dir, { recursive: true });

  const artifactPath = (name: string) => path.join(dir, `${name}.json`);
  const write = (name: string, data: unknown) => {
    fs.writeFileSync(artifactPath(name), JSON.stringify(data, null, 2));
    console.log(`  ✔ ${name.padEnd(10)} → ${path.relative(process.cwd(), artifactPath(name))}`);
  };
  const read = <T>(name: string, schema: z.ZodType<T>): T => {
    const file = artifactPath(name);
    if (!fs.existsSync(file)) {
      throw new Error(`artifact "${name}" not found at ${file} — run the earlier stages first (drop --only)`);
    }
    return schema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  };

  const wants = (stage: Stage) => !args.only || args.only === stage;
  console.log(`editable authoring — draft "${draftId}"${args.only ? ` (only: ${args.only})` : ""}`);

  const ingested = wants("ingest")
    ? args.url
      ? ingestFromUrl(args.url, draftId)
      : (() => {
          throw new Error("ingest: --url is required to (re-)ingest");
        })()
    : read("ingest", IngestResultSchema);
  if (wants("ingest")) write("ingest", ingested);
  if (args.only === "ingest") return;

  const analysis = wants("analyze")
    ? analyze(draftId, ingested.sourcePath, ingested.sourceUrl, ingested.durationSec, ingested.width, ingested.height)
    : read("analysis", AnalysisSchema);
  if (wants("analyze")) {
    write("analysis", analysis);
    console.log(`    ${analysis.words.length} words, ${analysis.shots.length} shots`);
  }
  if (args.only === "analyze") return;

  const draft = wants("synthesize") ? await synthesize(draftId, analysis) : read("draft", DraftSchema);
  if (wants("synthesize")) {
    write("draft", draft);
    console.log(`    "${draft.format.name}" (${draft.format.blocks.length} blocks) — ${draft.rationale}`);
  }
};

main().catch((err) => {
  console.error(`\n✖ ${(err as Error).message}`);
  process.exit(1);
});

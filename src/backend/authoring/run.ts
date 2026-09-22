import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AnalysisSchema, DraftSchema, IngestResultSchema, VerifyResultSchema } from "./schemas";
import { ingestFromFile, ingestFromUrl, newDraftId } from "./ingest";
import { analyze } from "./analyze";
import { synthesize } from "./synthesize";
import { verify } from "./verify";
import { authoringDir } from "../pipeline/paths";

/**
 * The format-authoring pipeline's CLI — the analog of pipeline/run.ts, but
 * for reverse-engineering a reference reel into a draft Format instead of
 * assembling a user's own video.
 *
 *   npm run author -- --url <reelUrl> [--draft <draftId>] [--only <stage>]
 *   npm run author -- --file <path/to/reel.mp4> [--draft <draftId>]
 *
 * Stages: ingest → analyze → synthesize → verify. Each writes its artifact
 * to authoring/<draftId>/ — same "inspect the artifact, not the video" idea
 * as the render pipeline. --only reruns a single stage against whatever's
 * already on disk (ingest itself is never skippable — it IS the source of
 * the draftId when one isn't given). "verify" self-checks the draft
 * against its own reference clip (see verify.ts) — it can be skipped or
 * re-run independently of "synthesize" via --only, same as any other stage.
 *
 * "validate" isn't a pipeline stage with its own artifact — it's a cheap,
 * render-free check of draft.json against DraftSchema (including
 * FormatSchema's cross-reference superRefine rules), for a draft.json an
 * agent wrote BY HAND instead of through synthesize()'s API call (see the
 * reel-to-template skill). Loop `--only validate` while fixing errors,
 * then move on to `--only verify` once it's clean — verify actually
 * renders, so it's much more expensive to iterate against.
 */

const STAGES = ["ingest", "analyze", "synthesize", "validate", "verify"] as const;
type Stage = (typeof STAGES)[number];

const parseArgs = (argv: string[]) => {
  const args: { url?: string; file?: string; draft?: string; only?: Stage } = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--url":
        args.url = argv[++i];
        break;
      case "--file":
        args.file = argv[++i];
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
  if (args.url && args.file) {
    throw new Error("--url and --file are mutually exclusive — a reel comes from one or the other");
  }
  if (!args.url && !args.file && !args.draft) {
    throw new Error(
      "usage: npm run author -- --url <reelUrl>|--file <path> [--draft <draftId>] " +
        "[--only ingest|analyze|synthesize|validate|verify]\n" +
        "  (--draft alone resumes an existing draft; --only needs an existing --draft)",
    );
  }
  // "ingest" is the entry stage — it CREATES the draft, so `--only ingest`
  // needs no pre-existing --draft. Every other stage resumes from an
  // earlier stage's artifact and has nothing to read without one.
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

  if (args.only === "validate") {
    const draftPath = artifactPath("draft");
    if (!fs.existsSync(draftPath)) {
      throw new Error(
        `artifact "draft" not found at ${draftPath} — run synthesize first, or write draft.json by hand`,
      );
    }
    const raw = JSON.parse(fs.readFileSync(draftPath, "utf8"));
    const parsed = DraftSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`draft.json failed validation:\n${z.prettifyError(parsed.error)}`);
    }
    console.log(`  ✔ draft.json is valid — "${parsed.data.format.name}" (${parsed.data.format.blocks.length} blocks)`);
    return;
  }

  const ingested = wants("ingest")
    ? args.url
      ? ingestFromUrl(args.url, draftId)
      : args.file
        ? ingestFromFile(args.file, draftId)
        : (() => {
            throw new Error("ingest: --url or --file is required to (re-)ingest");
          })()
    : read("ingest", IngestResultSchema);
  if (wants("ingest")) write("ingest", ingested);
  if (args.only === "ingest") return;

  const analysis = wants("analyze")
    ? analyze(draftId, ingested.sourcePath, ingested.sourceUrl, ingested.durationSec, ingested.width, ingested.height)
    : read("analysis", AnalysisSchema);
  if (wants("analyze")) {
    write("analysis", analysis);
    console.log(`    ${analysis.words.length} words, ${analysis.shots.length} shots, ${analysis.denseFrames.length} dense frames`);
  }
  if (args.only === "analyze") return;

  const draft = wants("synthesize") ? await synthesize(draftId, analysis) : read("draft", DraftSchema);
  if (wants("synthesize")) {
    write("draft", draft);
    console.log(`    "${draft.format.name}" (${draft.format.blocks.length} blocks) — ${draft.rationale}`);
  }
  if (args.only === "synthesize") return;

  const verifyResult = wants("verify")
    ? await verify(draftId, draft, analysis, ingested.sourcePath)
    : read("verify", VerifyResultSchema);
  if (wants("verify")) {
    write("verify", verifyResult);
    const scoreText = verifyResult.overallScore !== undefined ? verifyResult.overallScore.toFixed(3) : "n/a";
    const measured = verifyResult.blocks.filter((b) => typeof b.ssim === "number").length;
    console.log(`    overall score: ${scoreText} (${measured}/${verifyResult.blocks.length} blocks measured)`);
  }
};

main().catch((err) => {
  console.error(`\n✖ ${(err as Error).message}`);
  process.exit(1);
});

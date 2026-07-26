import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  EdlSchema,
  FilledFormatSchema,
  InsertsSchema,
  ResolvedRolesSchema,
  TranscriptSchema,
  TrimPointsSchema,
} from "./schemas";
import { intake } from "./intake";
import { loadFormat } from "./loader";
import { applyInserts, generate } from "./generate";
import { GeneratorChoice } from "./generation";
import { transcribe } from "./transcribe";
import { deriveTranscriptAndTrim } from "./splitTake";
import { readSplit, runSplit } from "./orchestrate";
import { correctTranscript } from "./correctTranscript";
import { trim } from "./trim";
import { resolveRoles } from "./resolveRoles";
import { ResolverChoice } from "./resolvers";
import { assemble } from "./assemble";
import { render } from "./render";
import { artifactsDir } from "./paths";

/**
 * The pipeline orchestrator.
 *
 *   npm run pipeline -- --job jobs/demo [--only <stage>] [--resolver <name>] [--generator <name>]
 *
 * Stages: intake → generate → transcribe → trim → roles → assemble → render.
 * Each stage writes its artifact to artifacts/<job>/ — the debugging
 * surface. When a video comes out wrong, look at which artifact first went
 * wrong, not at the video. --only re-runs a single stage against the
 * artifacts already on disk.
 *
 * "generate" fills any slot the format marks with a `generation` spec (an
 * insert — a cutaway or montage clip, never a voice block's own spoken
 * clip) with a synthesized MP4 and rewrites filled.json to include it —
 * the same "transform, then only the transformed version is persisted"
 * shape correctTranscript already uses for the transcript. A format with
 * no generated slots (every format prior to this) makes "generate" a
 * no-op that passes `filled` through unchanged.
 */

const STAGES = ["intake", "generate", "transcribe", "trim", "roles", "assemble", "render"] as const;
type Stage = (typeof STAGES)[number];

const parseArgs = (argv: string[]) => {
  const args: { job?: string; only?: Stage; resolver: ResolverChoice; generator: GeneratorChoice } = {
    resolver: "auto",
    generator: "auto",
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--job":
        args.job = argv[++i];
        break;
      case "--only": {
        const stage = argv[++i] as Stage;
        if (!STAGES.includes(stage)) {
          throw new Error(`--only must be one of: ${STAGES.join(", ")}`);
        }
        args.only = stage;
        break;
      }
      case "--resolver": {
        const resolver = argv[++i];
        if (!["anthropic", "claude-cli", "fallback", "auto"].includes(resolver)) {
          throw new Error("--resolver must be anthropic | claude-cli | fallback | auto");
        }
        args.resolver = resolver as ResolverChoice;
        break;
      }
      case "--generator": {
        const generator = argv[++i];
        if (!["fallback", "gemini", "auto"].includes(generator)) {
          throw new Error("--generator must be fallback | gemini | auto");
        }
        args.generator = generator as GeneratorChoice;
        break;
      }
      default:
        throw new Error(`unknown argument "${argv[i]}"`);
    }
  }
  if (!args.job) {
    throw new Error(
      "usage: npm run pipeline -- --job <jobDir> [--only <stage>] [--resolver <name>] [--generator <name>]",
    );
  }
  return args as { job: string; only?: Stage; resolver: ResolverChoice; generator: GeneratorChoice };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const jobId = path.basename(path.resolve(args.job));
  const dir = artifactsDir(jobId);
  fs.mkdirSync(dir, { recursive: true });

  const artifactPath = (name: string) => path.join(dir, `${name}.json`);
  const write = (name: string, data: unknown) => {
    fs.writeFileSync(artifactPath(name), JSON.stringify(data, null, 2));
    console.log(`  ✔ ${name.padEnd(10)} → ${path.relative(process.cwd(), artifactPath(name))}`);
  };
  const read = <T>(name: string, schema: z.ZodType<T>): T => {
    const file = artifactPath(name);
    if (!fs.existsSync(file)) {
      throw new Error(
        `artifact "${name}" not found at ${file} — run the earlier stages first (drop --only)`,
      );
    }
    return schema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  };

  const wants = (stage: Stage) => !args.only || args.only === stage;
  console.log(`editable pipeline — job "${jobId}"${args.only ? ` (only: ${args.only})` : ""}`);

  // Each stage either runs or is rehydrated from its artifact on disk.
  let filled = wants("intake") ? intake(args.job) : read("filled", FilledFormatSchema);
  if (wants("intake")) write("filled", filled);
  const format = loadFormat(filled.formatId);
  if (args.only === "intake") return;

  if (wants("generate")) {
    const result = await generate(format, filled, args.generator);
    // filled.json on disk stays pure intake output, always — generate's
    // merged view (with generated slots bound) is used in-memory for the
    // rest of THIS run, but only inserts.json records what was generated.
    // Persisting the merged view instead would make a later slot binding
    // indistinguishable from "the user supplied this," so a re-run of just
    // this stage could never tell a real user override apart from its own
    // prior output (and would treat every generated slot as already
    // filled, permanently skipping regeneration).
    filled = result.filled;
    write("inserts", result.inserts);
    for (const i of result.inserts.inserts) {
      console.log(
        `    generated ${i.blockId}/${i.slotName} (${i.kind}, ${i.durationSec.toFixed(2)}s${i.cacheHit ? ", cache hit" : ""})`,
      );
    }
    for (const s of result.inserts.skipped) {
      console.log(`    skipped generation for ${s.blockId}/${s.slotName} — user supplied their own clip`);
    }
  } else {
    // generate didn't run this invocation (e.g. --only transcribe) — restore
    // any bindings a prior run generated, from inserts.json alone (no
    // re-probing, no provider call), so later stages still see them bound.
    const insertsFile = artifactPath("inserts");
    if (fs.existsSync(insertsFile)) {
      const inserts = InsertsSchema.parse(JSON.parse(fs.readFileSync(insertsFile, "utf8")));
      filled = applyInserts(filled, inserts);
    }
  }
  if (args.only === "generate") return;

  // Single-take mode (speakingTakeSlot set): transcript/trim both come
  // from the split step (whisper once + sequential anchor matching — see
  // splitTake.ts) instead of the ordinary per-block transcribe()/trim().
  // Memoized so a full run computes it once even though both the
  // "transcribe" and "trim" stages below consult it.
  let singleTakeDerived: ReturnType<typeof deriveTranscriptAndTrim> | null = null;
  const getSingleTakeDerived = () => {
    if (!singleTakeDerived) {
      const split = readSplit(jobId) ?? runSplit(format, filled, jobId);
      singleTakeDerived = deriveTranscriptAndTrim(format, filled, split);
    }
    return singleTakeDerived;
  };

  let transcript = wants("transcribe")
    ? format.speakingTakeSlot
      ? getSingleTakeDerived().transcript
      : transcribe(format, filled)
    : read("transcript", TranscriptSchema);
  if (wants("transcribe")) {
    const before = transcript;
    transcript = await correctTranscript(filled, transcript, args.resolver);
    if (transcript !== before) {
      for (const block of transcript.blocks) {
        const rawBlock = before.blocks.find((b) => b.blockId === block.blockId)!;
        for (let t = 0; t < block.takes.length; t++) {
          for (let i = 0; i < block.takes[t].length; i++) {
            const was = rawBlock.takes[t][i].text;
            const now = block.takes[t][i].text;
            if (was !== now) {
              console.log(`    correction ${block.blockId}: "${was}" → "${now}"`);
            }
          }
        }
      }
    }
    write("transcript", transcript);
  }
  if (args.only === "transcribe") return;

  const trims = wants("trim")
    ? format.speakingTakeSlot
      ? getSingleTakeDerived().trim
      : await trim(format, filled, transcript, args.resolver)
    : read("trim", TrimPointsSchema);
  if (wants("trim")) {
    write("trim", trims);
    for (const d of trims.diagnostics) console.log(`    ${d}`);
  }
  if (args.only === "trim") return;

  const resolved = wants("roles")
    ? await resolveRoles(format, transcript, trims, args.resolver)
    : read("roles", ResolvedRolesSchema);
  if (wants("roles")) {
    write("roles", resolved);
    for (const r of resolved.roles) {
      const span =
        r.endSec !== undefined && r.endSec > r.timeSec
          ? `${r.timeSec.toFixed(2)}–${r.endSec.toFixed(2)}s`
          : `${r.timeSec.toFixed(2)}s`;
      console.log(
        `    anchor ${r.blockId}/${r.roleId}: ${span} (${r.source}, confidence ${r.confidence.toFixed(2)}${r.quote ? `, "${r.quote}"` : ""}${r.capturedText ? `, captured "${r.capturedText}"` : ""})`,
      );
    }
  }
  if (args.only === "roles") return;

  const edl = wants("assemble")
    ? assemble(format, filled, transcript, trims, resolved)
    : read("edl", EdlSchema);
  if (wants("assemble")) write("edl", edl);
  if (args.only === "assemble") return;

  const outPath = render(edl, dir);
  console.log(`\n✔ rendered ${path.relative(process.cwd(), outPath)} (${edl.durationSec.toFixed(2)}s, ${edl.width}x${edl.height}@${edl.fps}fps)`);
};

main().catch((err) => {
  console.error(`\n✖ ${(err as Error).message}`);
  process.exit(1);
});

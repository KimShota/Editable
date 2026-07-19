import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  EdlSchema,
  FilledFormatSchema,
  ResolvedRolesSchema,
  TranscriptSchema,
  TrimPointsSchema,
} from "./schemas";
import { intake } from "./intake";
import { loadFormat } from "./loader";
import { transcribe } from "./transcribe";
import { trim } from "./trim";
import { resolveRoles } from "./resolveRoles";
import { ResolverChoice } from "./resolvers";
import { assemble } from "./assemble";
import { render } from "./render";
import { artifactsDir } from "./paths";

/**
 * The pipeline orchestrator.
 *
 *   npm run pipeline -- --job jobs/demo [--only <stage>] [--resolver <name>]
 *
 * Stages: intake → transcribe → trim → roles → assemble → render.
 * Each stage writes its artifact to artifacts/<job>/ — the debugging
 * surface. When a video comes out wrong, look at which artifact first went
 * wrong, not at the video. --only re-runs a single stage against the
 * artifacts already on disk.
 */

const STAGES = ["intake", "transcribe", "trim", "roles", "assemble", "render"] as const;
type Stage = (typeof STAGES)[number];

const parseArgs = (argv: string[]) => {
  const args: { job?: string; only?: Stage; resolver: ResolverChoice } = {
    resolver: "auto",
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
      default:
        throw new Error(`unknown argument "${argv[i]}"`);
    }
  }
  if (!args.job) {
    throw new Error(
      "usage: npm run pipeline -- --job <jobDir> [--only <stage>] [--resolver <name>]",
    );
  }
  return args as { job: string; only?: Stage; resolver: ResolverChoice };
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
  const filled = wants("intake") ? intake(args.job) : read("filled", FilledFormatSchema);
  if (wants("intake")) write("filled", filled);
  const format = loadFormat(filled.formatId);
  if (args.only === "intake") return;

  const transcript = wants("transcribe")
    ? transcribe(format, filled)
    : read("transcript", TranscriptSchema);
  if (wants("transcribe")) write("transcript", transcript);
  if (args.only === "transcribe") return;

  const trims = wants("trim")
    ? trim(format, filled, transcript)
    : read("trim", TrimPointsSchema);
  if (wants("trim")) write("trim", trims);
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

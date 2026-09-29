import "dotenv/config";
import path from "node:path";
import { analyzeVideoFile } from "./analyzer";
import { ClaudeSemanticProvider } from "./semantic";

/**
 * Analyze one video file.
 *
 *   npm run analyze -- <file>                      print the measurements (no DB)
 *   npm run analyze -- <file> --json               the full VideoAnalysis as JSON
 *   npm run analyze -- <file> --semantic           also ask Claude what it is about (API cost)
 *   npm run analyze -- <file> --enqueue            store the file, add a videos row, queue it
 *        [--relation own|reference|library] [--owner <user uuid>]
 *
 * The first three need no database. `--enqueue` needs DATABASE_URL and a
 * running `npm run worker` to pick the job up.
 */

const USAGE = "usage: npm run analyze -- <file> [--json] [--semantic] [--enqueue [--relation own|reference|library] [--owner <uuid>]]";

const flag = (args: string[], name: string): boolean => args.includes(name);
const option = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

/** The first argument that is neither a flag nor the value of a valued option. */
const VALUED = new Set(["--relation", "--owner"]);
const positional = (args: string[]): string | undefined => {
  for (let i = 0; i < args.length; i++) {
    if (VALUED.has(args[i])) i++;
    else if (!args[i].startsWith("--")) return args[i];
  }
  return undefined;
};

const fmt = (n: number | null, digits = 2): string => (n === null ? "unknown" : n.toFixed(digits));

const enqueue = async (file: string, args: string[]): Promise<void> => {
  // Imported here so the local-only modes never touch the database module.
  const { query } = await import("../../app/lib/db");
  const { getStorage, hashFile, videoKey } = await import("../storage");
  const { insertVideo } = await import("./store");
  const { enqueueAnalysis } = await import("./handler");
  const { WorkQueue } = await import("../queue/workQueue");

  const relation = (option(args, "--relation") ?? "own") as "own" | "reference" | "library";
  if (!["own", "reference", "library"].includes(relation)) throw new Error(`bad --relation "${relation}"`);
  const ownerId = option(args, "--owner") ?? null;
  if (relation === "own" && !ownerId) throw new Error("--relation own needs --owner <user uuid>");

  const contentHash = await hashFile(file);
  const key = videoKey(contentHash, path.extname(file));
  await getStorage().putFile(key, file);
  const videoId = await insertVideo(query, { ownerId, relation, mediaKey: key, contentHash });
  const jobId = await enqueueAnalysis(new WorkQueue(query), videoId);
  console.log(`video ${videoId} stored as ${key}; ${jobId === null ? "already queued" : `queued as job ${jobId}`}`);
  console.log("run `npm run worker` to process it");
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const file = positional(args);
  if (!file) {
    console.error(USAGE);
    process.exit(2);
  }
  const abs = path.resolve(file);

  if (flag(args, "--enqueue")) return enqueue(abs, args);

  const { analysis, features } = await analyzeVideoFile(abs, {
    semantic: flag(args, "--semantic") ? new ClaudeSemanticProvider() : undefined,
  });

  if (flag(args, "--json")) {
    console.log(JSON.stringify({ analysis, features }, null, 2));
    return;
  }

  const { media, cuts, cutLenSec, audio, captions, punchIns } = analysis;
  console.log(`${path.basename(abs)}  ${media.width}x${media.height}  ${media.durationSec.toFixed(1)}s  ${media.fps.toFixed(0)}fps  audio=${media.hasAudio}`);
  console.log(`cuts        ${cuts.length} (${features.cutsPerMin.toFixed(1)}/min)  hard=${cuts.filter((c) => c.kind === "hard").length} jump=${cuts.filter((c) => c.kind === "jump").length}`);
  console.log(`cut length  p10=${cutLenSec.p10.toFixed(2)} p50=${cutLenSec.p50.toFixed(2)} p90=${cutLenSec.p90.toFixed(2)}s  hook=${features.hookSec.toFixed(2)}s`);
  console.log(`camera      punch-ins=${punchIns.filter((p) => p.direction === "in").length}  energy=${features.energy.toFixed(2)}  shake=${features.shake.toFixed(2)}`);
  console.log(`audio       loudness=${fmt(audio.loudnessMeanDb, 1)}dB  speech=${fmt(audio.speechRatio)}  bed=${fmt(audio.musicRatio)}  bpm=${fmt(audio.beat.bpm, 1)} (conf ${audio.beat.confidence.toFixed(2)})  sfx=${audio.sfxOnsetsSec.length}`);
  console.log(`captions    ${captions.measured ? `${captions.mode} (coverage ${fmt(captions.coverage)}, ${fmt(captions.medianWords, 0)} words, ${captions.position ?? "-"})` : "unknown"}`);
  console.log(`look        luma=${features.lumaMean.toFixed(2)} spread=${features.lumaSpread.toFixed(2)} sat=${features.satMean.toFixed(2)} warmth=${features.warmth.toFixed(2)}`);
  if (analysis.semantic) console.log(`semantic    ${analysis.semantic.formatType} / ${analysis.semantic.hookType} hook — ${analysis.semantic.topic}`);
  for (const w of analysis.warnings) console.log(`warning     ${w}`);
};

main().catch((err) => {
  console.error("analyze failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

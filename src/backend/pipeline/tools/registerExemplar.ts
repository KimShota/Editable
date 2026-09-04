import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { formatAssetsDir } from "../paths";
import { detectChangeTimes } from "../shotDetect";
import { loadFormat } from "../loader";
import { loadReferenceBeats, referenceBeatsPath, ReferenceBeatSheetSchema } from "../referenceBeats";

/**
 * Authoring tool — registers a hand-cut EXEMPLAR for one beat of a
 * format's reference sheet (see referenceBeats.ts).
 *
 *   npm run reference:exemplar -- --format daily-vlog-timeline \
 *     --beat hook --clip ~/Desktop/intro.mov \
 *     --rule "顔とコントローラーが入った落ち着いた画角のリアクション。冒頭のカメラ設置中は使わない"
 *
 * This is the correction loop for a beat the pipeline keeps getting
 * wrong: rather than arguing with a prompt, the creator trims three
 * seconds of the moment done RIGHT out of their own footage, and every
 * future episode is judged against that example. The clip is transcoded
 * small (it is only ever read as sampled frames, never rendered) and
 * checked in beside the format so the correction travels with it.
 */

/** Small on purpose: the clip is only ever sampled into a handful of
 *  prompt frames, so keeping full quality would bloat the repo for
 *  nothing. Wide enough that on-screen clocks stay legible. */
const EXEMPLAR_WIDTH = 540;

const parseArgs = (argv: string[]) => {
  const args: { format?: string; beat?: string; clip?: string; rule?: string; note?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--format":
        args.format = argv[++i];
        break;
      case "--beat":
        args.beat = argv[++i];
        break;
      case "--clip":
        args.clip = argv[++i];
        break;
      case "--rule":
        args.rule = argv[++i];
        break;
      case "--note":
        args.note = argv[++i];
        break;
      default:
        throw new Error(`unknown argument "${argv[i]}"`);
    }
  }
  if (!args.format || !args.beat || !args.clip) {
    throw new Error(
      'usage: npm run reference:exemplar -- --format <formatId> --beat <beatId> --clip <file> [--rule "..."] [--note "..."]',
    );
  }
  return args as { format: string; beat: string; clip: string; rule?: string; note?: string };
};

const probeDurationSec = (file: string): number =>
  Number(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], {
      encoding: "utf8",
    }).trim(),
  );

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  const format = loadFormat(args.format);
  const sheet = loadReferenceBeats(format.id);
  if (!sheet) {
    throw new Error(
      `format "${format.id}" has no reference beat sheet yet — run "npm run reference:beats" first (see buildReferenceBeats.ts)`,
    );
  }
  const beat = sheet.beats.find((b) => b.id === args.beat);
  if (!beat) {
    throw new Error(`format "${format.id}" has no beat "${args.beat}" — known beats: ${sheet.beats.map((b) => b.id).join(", ")}`);
  }
  const srcClip = path.resolve(args.clip);
  if (!fs.existsSync(srcClip)) throw new Error(`clip not found: ${srcClip}`);

  const durationSec = probeDurationSec(srcClip);
  // A hand-cut beat is often two quick shots (the coffee, then the
  // selfie), so the per-CUT length — what discover.ts actually budgets
  // against — needs the cut count, not just the total.
  const shotCount = detectChangeTimes(srcClip, 0.15).filter((t) => t > 0.1 && t < durationSec - 0.1).length + 1;
  const seq = beat.exemplars.length + 1;
  const relPath = path.join("exemplars", `${beat.id}-${seq}.mp4`);
  const destPath = path.join(formatAssetsDir(format.id), relPath);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-i", srcClip,
    "-vf", `scale=${EXEMPLAR_WIDTH}:-2`,
    "-c:v", "libx264", "-crf", "28", "-preset", "veryfast",
    "-an",
    destPath,
  ]);

  beat.exemplars.push({
    clip: relPath,
    durationSec: Number(durationSec.toFixed(2)),
    shotCount,
    ...(args.rule ? { rule: args.rule } : {}),
    ...(args.note ? { sourceNote: args.note } : {}),
  });
  const validated = ReferenceBeatSheetSchema.parse(sheet);
  fs.writeFileSync(referenceBeatsPath(format.id), JSON.stringify(validated, null, 2));

  const kb = (fs.statSync(destPath).size / 1024).toFixed(0);
  console.log(
    `✔ exemplar ${seq} for beat "${beat.id}" (${beat.label}) — ${durationSec.toFixed(2)}s in ${shotCount} cut(s), ${kb}KB`,
  );
  console.log(`  ${path.relative(process.cwd(), destPath)}`);
  if (args.rule) console.log(`  rule: ${args.rule}`);
};

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

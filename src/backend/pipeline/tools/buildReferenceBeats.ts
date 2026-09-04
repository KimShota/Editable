import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { requireWhisperModel, transcribeFile } from "../whisper";
import { buildShots, detectChangeTimes, downsampleEvenly, extractFrame } from "../shotDetect";
import { formatAssetsDir } from "../paths";
import { loadFormat } from "../loader";
import { ReferenceBeatSheetSchema, referenceBeatsPath } from "../referenceBeats";
import { Word } from "../types";

/**
 * Authoring tool — builds a format's canonical beat sheet (see
 * referenceBeats.ts) from the creator's OWN published videos.
 *
 *   npm run reference:beats -- --format daily-vlog-timeline --samples <file|dir>...
 *
 * The reference videos are already-edited finished reels, so their hard
 * cuts ARE the beat boundaries and their burned-in captions ARE the
 * caption style — one frame per shot is enough for a multimodal model to
 * read both, and the transcript supplies what was actually said. The
 * result is the union of what every sample has in common, in the order
 * they all share, written to formats/assets/<formatId>/referenceBeats.json
 * for discover.ts to match a new job's raw footage against.
 *
 * Run once per format, and again whenever the creator's style drifts or
 * more samples arrive — the beat sheet is checked-in data, so a rebuild is
 * a reviewable diff rather than a silent behavior change.
 */

const SCENE_THRESHOLD = 0.3;
const MAX_SHOTS_PER_SAMPLE = 30;
const FRAME_WIDTH = 480;
const DEFAULT_MODEL = "claude-opus-4-8";
const MAX_TOKENS = 24000;

const parseArgs = (argv: string[]) => {
  const args: { format?: string; samples: string[] } = { samples: [] };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--format":
        args.format = argv[++i];
        break;
      case "--samples":
        while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) args.samples.push(argv[++i]);
        break;
      default:
        throw new Error(`unknown argument "${argv[i]}"`);
    }
  }
  if (!args.format || args.samples.length === 0) {
    throw new Error("usage: npm run reference:beats -- --format <formatId> --samples <file|dir>...");
  }
  return args as { format: string; samples: string[] };
};

/** Expands a directory argument into the video files inside it, so
 *  `--samples <dir>` works as well as an explicit file list. */
const expandSamples = (inputs: string[]): string[] =>
  inputs.flatMap((input) => {
    const abs = path.resolve(input);
    if (!fs.existsSync(abs)) throw new Error(`sample not found: ${abs}`);
    if (!fs.statSync(abs).isDirectory()) return [abs];
    return fs
      .readdirSync(abs)
      .filter((f) => /\.(mp4|mov|m4v)$/i.test(f))
      .map((f) => path.join(abs, f))
      .sort();
  });

const probeDurationSec = (file: string): number => {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" },
  );
  return Number(out.trim());
};

const formatWords = (words: Word[], startSec: number, endSec: number): string => {
  const inShot = words.filter((w) => w.startSec >= startSec && w.startSec < endSec);
  return inShot.length === 0 ? "(no speech)" : inShot.map((w) => w.text).join("");
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const format = loadFormat(args.format);
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("reference:beats requires ANTHROPIC_API_KEY (put it in .env) — it reads sampled frames.");
  }
  const samples = expandSamples(args.samples);
  console.log(`building reference beats for "${format.id}" from ${samples.length} sample(s)`);

  requireWhisperModel();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-refbeats-"));
  try {
    const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
    const durations: number[] = [];

    for (const [sampleIdx, file] of samples.entries()) {
      const durationSec = probeDurationSec(file);
      durations.push(durationSec);
      const words = transcribeFile(file, workDir, format.discovery ? "ja" : "auto");
      const shots = downsampleEvenly(
        buildShots(detectChangeTimes(file, SCENE_THRESHOLD), durationSec, MAX_SHOTS_PER_SAMPLE),
        MAX_SHOTS_PER_SAMPLE,
      );
      console.log(`  ${path.basename(file)} — ${durationSec.toFixed(1)}s, ${shots.length} shots`);

      content.push({
        type: "text",
        text: `\n=== REFERENCE VIDEO ${sampleIdx + 1}: ${path.basename(file)} (${durationSec.toFixed(1)}s, ${shots.length} shots) ===`,
      });
      shots.forEach((shot, i) => {
        const mid = (shot.startSec + shot.endSec) / 2;
        const framePath = path.join(workDir, `s${sampleIdx}_${String(i).padStart(3, "0")}.jpg`);
        if (!extractFrame(file, mid, framePath, FRAME_WIDTH)) return;
        content.push({
          type: "text",
          text: `Video ${sampleIdx + 1} shot ${i} — ${shot.startSec.toFixed(1)}s-${shot.endSec.toFixed(1)}s. Spoken: ${formatWords(words, shot.startSec, shot.endSec)}`,
        });
        content.push({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: fs.readFileSync(framePath).toString("base64") },
        });
      });
    }

    const prompt = `These are ${samples.length} finished, published videos by ONE creator, all made to the SAME repeating format — same structure, same running order, same caption style, only the day's content differs. Each shot below is shown with its time range, what was spoken in it, and one frame (the frame shows the burned-in on-screen captions — read them).

Your job: extract the CANONICAL BEAT SHEET this creator follows every episode, so a new episode's raw footage can be matched against it.

Produce an ordered list of beats. A beat is one recurring moment of the format — the thing that shows up, in the same slot, in most or all of these videos (e.g. the cold-open hook, waking up, the morning greeting to camera, breakfast, the day's main activity, the stream, the bath, the sign-off). Ignore one-off content unique to a single episode.

For each beat give:
- "id": short stable ascii slug, e.g. "hook", "wake", "greeting", "breakfast", "stream", "bath", "signoff"
- "order": 0-based canonical position in the running order
- "label": short Japanese label
- "description": what the shot LOOKS like and what is typically SAID in it — concrete enough that a model can recognize this beat in unseen raw footage it has never seen edited. Mention framing, action, and the typical spoken line.
- "captionExamples": the actual on-screen caption text you can read for this beat across the videos (verbatim, Japanese)
- "typicalClockTime": the time-of-day caption usually shown, "H:MM" (omit if this beat carries no time)
- "optional": false if the beat appears in essentially every video, true if it only shows up in some
- "isTitleBeat": true for the ONE opening beat that carries the multi-line title card, false for all others

Also give "typicalTotalSec": the typical finished length of one of these videos, in seconds.

HARD CONSTRAINTS on the running order:
- "order" must run 0,1,2,… with no gaps or duplicates, and must follow the day CHRONOLOGICALLY, exactly as these videos play back.
- Every beat that carries a "typicalClockTime" must be non-decreasing in time as "order" increases. If two beats' times would contradict their order, you have the order wrong — fix it.
- The beat with "isTitleBeat" must be order 0 (the cold open).
- Only include a beat you can actually point at in these videos. Do not invent a beat you think the format "should" have.

Be faithful to what the videos actually show — this sheet becomes the template every future episode is built against.`;

    const client = new Anthropic();
    const model = process.env.EDITABLE_LLM_MODEL || DEFAULT_MODEL;
    const OutputSchema = ReferenceBeatSheetSchema.omit({ formatId: true, sources: true });
    // Streamed, not parse(): the SDK requires streaming once a request may
    // run past 10 minutes, which a many-image call with adaptive thinking
    // does. finalMessage() still carries parsed_output from output_config.
    const response = await client.messages
      .stream({
        model,
        max_tokens: MAX_TOKENS,
        thinking: { type: "adaptive" },
        messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...content] }],
        output_config: { format: zodOutputFormat(OutputSchema) },
      })
      .finalMessage();
    if (!response.parsed_output) throw new Error("reference:beats — model response did not match the expected schema");

    const sheet = {
      formatId: format.id,
      sources: samples.map((s) => path.basename(s)),
      typicalTotalSec:
        response.parsed_output.typicalTotalSec ?? durations.reduce((a, b) => a + b, 0) / durations.length,
      beats: [...response.parsed_output.beats].sort((a, b) => a.order - b.order),
    };
    const validated = ReferenceBeatSheetSchema.parse(sheet);

    const outPath = referenceBeatsPath(format.id);
    fs.mkdirSync(formatAssetsDir(format.id), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(validated, null, 2));
    console.log(`\n✔ ${validated.beats.length} beats → ${path.relative(process.cwd(), outPath)}`);
    for (const b of validated.beats) {
      console.log(`  ${String(b.order).padStart(2)} ${b.id.padEnd(14)} ${b.typicalClockTime ?? "  —  "}  ${b.label}`);
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

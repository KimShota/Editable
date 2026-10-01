import "dotenv/config";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeVideoFile } from "../analysis/analyzer";
import { VideoAnalysisSchema } from "../analysis/schemas";
import { consoleSink } from "../cost/ledger";
import { extractFrame } from "../pipeline/shotDetect";
import { getStorage } from "../storage";
import { assembleSpec, decompose, type Keyframe, keyframeTimes, type SourceMeta, sourceIdFromUrl } from "./decompose";
import { type RecreationSpec, RecreationSpecSchema } from "./schemas";

/**
 * Viral source videos → RecreationSpecs, run by hand in the pilot (M1 day 3).
 * State is files under storage key brands/<brand>/sources/:
 *
 *   <id>.mp4, <id>.info.json      the downloaded source (yt-dlp)
 *   analysis/<id>.json            the analyzer's measurements
 *   keyframes/<id>/s<i>-<k>.jpg   composition references per shot
 *   specs/<id>.json               the RecreationSpec
 *
 *   npm run recreate -- ingest --brand <slug> --url <url> [--url <url> …]
 *   npm run recreate -- spec   --brand <slug> [--source <id>]     (all downloaded sources when omitted)
 *   npm run recreate -- show   --brand <slug> [--source <id>]
 */

const USAGE = "usage: npm run recreate -- <ingest|spec|show> --brand <slug> [options]  (see cli.ts)";

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

const keys = (brand: string) => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(brand)) throw new Error(`--brand must be a lowercase slug, got "${brand}"`);
  const root = `brands/${brand}/sources`;
  return {
    root,
    video: (id: string) => `${root}/${id}.mp4`,
    info: (id: string) => `${root}/${id}.info.json`,
    analysis: (id: string) => `${root}/analysis/${id}.json`,
    keyframe: (id: string, shot: number, k: number) => `${root}/keyframes/${id}/s${shot}-${k}.jpg`,
    spec: (id: string) => `${root}/specs/${id}.json`,
  };
};

const sourceIds = async (brand: string, only?: string): Promise<string[]> => {
  if (only) return [only];
  const k = keys(brand);
  return (await storage.list(k.root)).filter((f) => /\/[^/]+\.mp4$/.test(f) && !f.includes("/keyframes/")).map((f) => f.split("/").pop()!.replace(/\.mp4$/, ""));
};

const readMeta = async (brand: string, id: string): Promise<SourceMeta> => {
  const k = keys(brand);
  if (!(await storage.exists(k.info(id)))) return { sourceId: id, url: null, creator: null, likes: null, comments: null, views: null };
  const info = JSON.parse(fs.readFileSync(await storage.localPath(k.info(id)), "utf8")) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    sourceId: id,
    url: (info.webpage_url as string) ?? null,
    creator: (info.uploader as string) || (info.channel as string) || null,
    likes: num(info.like_count),
    comments: num(info.comment_count),
    views: num(info.view_count),
  };
};

const commands: Record<string, (args: string[]) => Promise<void>> = {
  ingest: async (args) => {
    const brand = required(args, "--brand");
    const k = keys(brand);
    const urls = options(args, "--url");
    if (urls.length === 0) throw new Error(`missing --url\n${USAGE}`);
    for (const url of urls) {
      const id = sourceIdFromUrl(url);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "katalab-ingest-"));
      try {
        // Same yt-dlp invocation as authoring/ingest.ts, plus the info JSON
        // for the creator and engagement numbers.
        const ytArgs = ["-q", "--no-warnings", "-f", "mp4/best", "--no-playlist", "--merge-output-format", "mp4", "--write-info-json", "-o", path.join(dir, "v.%(ext)s"), url];
        const cookies = process.env.EDITABLE_YTDLP_COOKIES_BROWSER;
        if (cookies) ytArgs.unshift("--cookies-from-browser", cookies);
        execFileSync("yt-dlp", ytArgs, { stdio: ["ignore", "ignore", "pipe"] });
        await storage.putFile(k.video(id), path.join(dir, "v.mp4"));
        if (fs.existsSync(path.join(dir, "v.info.json"))) await storage.putFile(k.info(id), path.join(dir, "v.info.json"));
        console.log(`  ✔ ${id}  ${await storage.localPath(k.video(id))}`);
      } catch (err) {
        console.log(`  ✘ ${id}: ${(err as { stderr?: Buffer }).stderr?.toString().slice(-500) ?? err}`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  },

  spec: async (args) => {
    const brand = required(args, "--brand");
    const k = keys(brand);
    for (const id of await sourceIds(brand, option(args, "--source"))) {
      console.log(`\n${id}`);
      if (!(await storage.exists(k.video(id)))) throw new Error(`no source video ${k.video(id)}: run ingest first`);
      const videoPath = await storage.localPath(k.video(id));

      // Measure (cached on disk).
      let analysis;
      if (await storage.exists(k.analysis(id))) {
        analysis = VideoAnalysisSchema.parse(JSON.parse(fs.readFileSync(await storage.localPath(k.analysis(id)), "utf8")).analysis);
      } else {
        const result = await analyzeVideoFile(videoPath);
        await storage.putBuffer(k.analysis(id), Buffer.from(JSON.stringify(result, null, 2)));
        analysis = result.analysis;
      }
      console.log(`  measured: ${analysis.shots.length} shots, ${analysis.transcript?.words.length ?? 0} words`);

      // Keyframes per shot, kept: day 4's storyboards use them for composition.
      const keyframes: Keyframe[] = [];
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "katalab-keyframes-"));
      try {
        for (const [i, s] of analysis.shots.entries()) {
          for (const [j, atSec] of keyframeTimes(s.startSec, s.endSec).entries()) {
            const key = k.keyframe(id, i, j);
            if (!(await storage.exists(key))) {
              const out = path.join(tmp, `s${i}-${j}.jpg`);
              if (!extractFrame(videoPath, atSec, out, 720)) continue;
              await storage.putFile(key, out);
            }
            keyframes.push({ shotIndex: i, atSec, path: await storage.localPath(key), key });
          }
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      console.log(`  keyframes: ${keyframes.length}`);

      const { decomposition, model } = await decompose(analysis, keyframes, { costSink: consoleSink, ref: `${brand}/${id}` });
      const spec = RecreationSpecSchema.parse(assembleSpec(analysis, decomposition, keyframes, await readMeta(brand, id), model));
      await storage.putBuffer(k.spec(id), Buffer.from(JSON.stringify(spec, null, 2)));
      printSpec(spec);
      console.log(`  saved ${k.spec(id)}`);
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

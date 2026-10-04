import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeVideoFile } from "../analysis/analyzer";
import { VideoAnalysisSchema } from "../analysis/schemas";
import { BrandIntakeSchema } from "../brand/intake/schemas";
import { recreationKeys } from "../brand/keys";
import { LockedCharacterSchema } from "../character/schemas";
import { type CostSink, googleImageCostEntry } from "../cost/ledger";
import { GEMINI_IMAGE_MODEL, generateImage } from "../pipeline/generation/geminiImage";
import { extractFrame } from "../pipeline/shotDetect";
import type { TaskProgress } from "../queue/workQueue";
import type { Storage } from "../storage";
import { readJson, writeJson } from "../storageJson";
import { type AdaptOptions, adapt, assembleScript } from "./adapt";
import { assembleSpec, decompose, type Keyframe, keyframeTimes, type SourceMeta, sourceIdFromUrl } from "./decompose";
import { type AdaptedScript, AdaptedScriptSchema, ProductFootageSchema, type RecreationSpec, RecreationSpecSchema } from "./schemas";
import { boardHtml, type FramePlan, planFrames } from "./storyboard";

/**
 * The recreation steps as functions: what `npm run recreate` does, callable
 * from the CLI (cli.ts) and from queue handlers (jobs/) alike. The CLI file
 * runs on import, so nothing a handler needs can live there.
 *
 * Every step takes the Storage and a CostSink explicitly and reports
 * progress through an optional callback, which is how a handler shows
 * "storyboard · shot 3 of 7" in the app.
 */

export type OpDeps = {
  storage: Storage;
  costSink: CostSink;
  report?: (progress: TaskProgress) => void;
};

/** Downloads one viral video with yt-dlp into a brand's source pool and
 *  returns its id. Same invocation as authoring/ingest.ts, plus the info JSON
 *  for the creator and engagement numbers. Throws with yt-dlp's last output
 *  when the download fails. */
export const ingestSource = async (storage: Storage, slug: string, url: string): Promise<string> => {
  const k = recreationKeys(slug);
  const id = sourceIdFromUrl(url);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "katalab-ingest-"));
  try {
    const ytArgs = ["-q", "--no-warnings", "-f", "mp4/best", "--no-playlist", "--merge-output-format", "mp4", "--write-info-json", "-o", path.join(dir, "v.%(ext)s"), url];
    const cookies = process.env.EDITABLE_YTDLP_COOKIES_BROWSER;
    if (cookies) ytArgs.unshift("--cookies-from-browser", cookies);
    try {
      execFileSync("yt-dlp", ytArgs, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      throw new Error(`could not download ${url}: ${(err as { stderr?: Buffer }).stderr?.toString().slice(-500) ?? err}`);
    }
    await storage.putFile(k.video(id), path.join(dir, "v.mp4"));
    if (fs.existsSync(path.join(dir, "v.info.json"))) await storage.putFile(k.info(id), path.join(dir, "v.info.json"));
    return id;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

export const readSourceMeta = async (storage: Storage, slug: string, id: string): Promise<SourceMeta> => {
  const k = recreationKeys(slug);
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

/** Source video → RecreationSpec: measure it (cached), keep keyframes per
 *  shot, have Claude label what each shot is, and save the spec. */
export const buildSpec = async ({ storage, costSink, report }: OpDeps, slug: string, id: string): Promise<RecreationSpec> => {
  const k = recreationKeys(slug);
  if (!(await storage.exists(k.video(id)))) throw new Error(`no source video ${k.video(id)}: run ingest first`);
  const videoPath = await storage.localPath(k.video(id));

  report?.({ stage: "Measuring the video" });
  let analysis;
  if (await storage.exists(k.analysis(id))) {
    analysis = VideoAnalysisSchema.parse(JSON.parse(fs.readFileSync(await storage.localPath(k.analysis(id)), "utf8")).analysis);
  } else {
    const result = await analyzeVideoFile(videoPath);
    await storage.putBuffer(k.analysis(id), Buffer.from(JSON.stringify(result, null, 2)));
    analysis = result.analysis;
  }

  // Keyframes per shot, kept: storyboards use them for composition.
  report?.({ stage: "Picking keyframes", message: `${analysis.shots.length} shots` });
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

  report?.({ stage: "Understanding how it works" });
  const { decomposition, model } = await decompose(analysis, keyframes, { costSink, ref: `${slug}/${id}` });
  const spec = RecreationSpecSchema.parse(assembleSpec(analysis, decomposition, keyframes, await readSourceMeta(storage, slug, id), model));
  await writeJson(storage, k.spec(id), spec);
  return spec;
};

/** Rewrites a source's spec for the brand: same skeleton, the brand's words.
 *  The script is saved under the CARD id (a source may back several cards). */
export const adaptCard = async ({ storage, costSink, report }: OpDeps, slug: string, cardId: string, sourceId: string, opts: AdaptOptions = {}): Promise<AdaptedScript> => {
  const k = recreationKeys(slug);
  report?.({ stage: "Reading the brand" });
  const intake = BrandIntakeSchema.parse(await readJson(storage, k.intake, "brand intake"));
  const character = LockedCharacterSchema.parse(await readJson(storage, k.character, "locked character"));
  const footage = ProductFootageSchema.parse(await readJson(storage, k.footage, "product footage"));
  if (!(await storage.exists(k.spec(sourceId)))) throw new Error(`${sourceId}: no spec yet, run spec first`);
  const spec = RecreationSpecSchema.parse(await readJson(storage, k.spec(sourceId), "spec"));

  report?.({ stage: "Writing the script" });
  const { adaptation, model } = await adapt(spec, intake, character, footage, { ...opts, costSink, ref: `${slug}/${cardId}` });
  const script = AdaptedScriptSchema.parse(assembleScript(spec, adaptation, footage, { brand: slug, language: intake.language, keep: opts.keep }, model));
  await writeJson(storage, k.script(cardId), script);
  return script;
};

export type StoryboardOptions = { shots?: string[]; redo?: boolean; set?: string; screenRefKey?: string };
export type StoryboardResult = { generated: string[]; failed: string[]; footageShots: number; boardKey: string };

/** One still per shot from the character sheet, the source composition and
 *  real product footage; a few at a time, and one failed shot is reported,
 *  not fatal. Writes the board page next to the stills. */
export const storyboardCard = async ({ storage, costSink, report }: OpDeps, slug: string, cardId: string, sourceId: string, opts: StoryboardOptions = {}): Promise<StoryboardResult> => {
  const k = recreationKeys(slug);
  const dir = k.board(cardId);
  const script = AdaptedScriptSchema.parse(await readJson(storage, k.script(cardId), "adapted script (run adapt first)"));
  const spec = RecreationSpecSchema.parse(await readJson(storage, k.spec(sourceId), "spec"));
  const character = LockedCharacterSchema.parse(await readJson(storage, k.character, "locked character"));
  const footage = ProductFootageSchema.parse(await readJson(storage, k.footage, "product footage"));

  // One frame from the middle of every footage clip the script uses.
  const footageKey = (clipId: string) => `${dir}/footage/${clipId}.jpg`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "katalab-board-"));
  try {
    for (const clipId of new Set(script.shots.flatMap((s) => (s.footageId ? [s.footageId] : [])))) {
      if (await storage.exists(footageKey(clipId))) continue;
      const clip = footage.clips.find((c) => c.id === clipId)!;
      const out = path.join(tmp, `${clipId}.jpg`);
      if (!extractFrame(await storage.localPath(clip.key), (clip.startSec + clip.endSec) / 2, out, 1600)) throw new Error(`could not extract a frame of ${clipId}`);
      await storage.putFile(footageKey(clipId), out);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const plans = planFrames(script, spec, character, footageKey, opts.set, opts.screenRefKey);
  const stillKey = (shotId: string) => `${dir}/${shotId}.png`;
  const todo: Extract<FramePlan, { mode: "generate" }>[] = [];
  for (const p of plans) {
    if (p.mode !== "generate" || (opts.shots && !opts.shots.includes(p.shotId))) continue;
    if (!opts.redo && (await storage.exists(stillKey(p.shotId)))) continue;
    todo.push(p);
  }

  const generated: string[] = [];
  const failed: string[] = [];
  let done = 0;
  report?.({ stage: "Generating stills", done, total: todo.length });
  const run = async (p: (typeof todo)[number]) => {
    try {
      const refPaths = await Promise.all(p.refs.map((r) => storage.localPath(r.key)));
      const bytes = await generateImage(p.prompt, refPaths, refPaths.length, { aspectRatio: "9:16", imageSize: "2K" });
      await costSink(googleImageCostEntry(GEMINI_IMAGE_MODEL, 1, "storyboard_frame", { ref: `${slug}/${cardId}/${p.shotId}` }));
      await storage.putBuffer(stillKey(p.shotId), bytes);
      generated.push(p.shotId);
    } catch (err) {
      failed.push(`${p.shotId}: ${err instanceof Error ? err.message.slice(0, 300) : err}`);
    }
    report?.({ stage: "Generating stills", done: ++done, total: todo.length, message: p.shotId });
  };
  for (let i = 0; i < todo.length; i += 3) await Promise.all(todo.slice(i, i + 3).map(run));

  const images = new Map<string, string>();
  for (const p of plans) {
    if (p.mode === "footage") images.set(p.shotId, `footage/${p.footageId}.jpg`);
    else if (p.mode === "generate" && (await storage.exists(stillKey(p.shotId)))) images.set(p.shotId, `${p.shotId}.png`);
  }
  const boardKey = `${dir}/board.html`;
  await storage.putBuffer(boardKey, Buffer.from(boardHtml(script, (shotId) => images.get(shotId) ?? null)));
  return { generated, failed, footageShots: plans.filter((p) => p.mode === "footage").length, boardKey };
};

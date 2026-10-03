import "dotenv/config";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LockedCharacterSchema } from "../character/schemas";
import { consoleSink, googleImageCostEntry } from "../cost/ledger";
import { GEMINI_IMAGE_MODEL, generateImage } from "../pipeline/generation/geminiImage";
import { artifactsDir, repoRoot } from "../pipeline/paths";
import { render, stageAssets } from "../pipeline/render";
import { EdlSchema } from "../pipeline/schemas";
import { AdaptedScriptSchema, ProductFootageSchema, RecreationSpecSchema } from "../recreation/schemas";
import { DEFAULT_SET, framePrompt, planFrames } from "../recreation/storyboard";
import { getStorage } from "../storage";
import { textToSpeechTimed, type TimedWord } from "../voice/elevenlabs";
import {
  ANIMATE_MODEL,
  animatePrompt,
  type ClipKind,
  durationOf,
  footageClip,
  greenscreenScript,
  mixVoiceTrack,
  normalize,
  planClip,
  requestSeconds,
  speechAlign,
  whisperModel,
  TALKING_MODEL,
  talkingPrompt,
  textCardClip,
  voiceSegment,
} from "./clips";
import { compileEdl, type MadeClip, swapShotClip, type VoiceFile } from "./edl";
import { AI_VIDEO_FORMAT } from "./format";
import { addTake } from "./takes";
import { estimateUsd, generate, seedanceUsd, uploadFile, waitFor, download } from "./higgsfield";
import { buildTimeline, type Timeline } from "./timeline";

/**
 * An adapted script → a finished, editable video (M1 day 5-6), run by hand
 * in the pilot. Every step caches its output under
 * brands/<brand>/videos/<source>/ and is safe to rerun; --redo regenerates.
 *
 *   npm run produce -- voice  --brand <slug> --source <id> [--tempo 1.25] [--redo]
 *   npm run produce -- clips  --brand <slug> --source <id> [--shots s0,s3] [--redo | --regenerate | --new-stills] [--dry]
 *       --redo rebuilds clips from what the providers already returned (free);
 *       --regenerate pays for new generations; --new-stills also redraws green-screen stills
 *   npm run produce -- render --brand <slug> --source <id> [--discard-edits]
 *       also makes the video a project the app's editor opens (jobs/<brand>-<source>)
 *   npm run produce -- regen-clip --job <jobId> --clip <clipId> [--dry]
 *       a new take of one shot, swapped into the editor's timeline (the Regenerate button)
 *   npm run produce -- all    --brand <slug> --source <id> [--dry]
 *
 *   voice/line-<i>.tts.mp3/.json each line as ElevenLabs spoke it, with word timings
 *   voice/line-<i>.mp3 + .json   the same at the video's tempo (what plays)
 *   voice/track.wav              all lines at their timeline positions
 *   timeline.json                where every line and shot sits
 *   stills/<shot>-green.png      green-screen stills for shots that show the product
 *   clips/<shot>.raw.mp4         what the provider returned
 *   clips/<shot>.mp4             the shot, normalized (and composited)
 *   clips.json                   per shot: kind, file, length, lip-sync offset
 *   edl.json, final.mp4          the editable timeline and its render
 */

const USAGE = "usage: npm run produce -- <voice|clips|render|all> --brand <slug> --source <id> [options], or regen-clip --job <id> --clip <id>  (see cli.ts)";

const option = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const required = (args: string[], name: string): string => {
  const v = option(args, name);
  if (!v) throw new Error(`missing ${name}\n${USAGE}`);
  return v;
};

const storage = getStorage();

const readJson = async (key: string, what: string): Promise<unknown> => {
  if (!(await storage.exists(key))) throw new Error(`no ${what} at ${key}`);
  return JSON.parse(fs.readFileSync(await storage.localPath(key), "utf8"));
};
const writeJson = (key: string, value: unknown) => storage.putBuffer(key, Buffer.from(JSON.stringify(value, null, 2)));

const context = async (args: string[]) => {
  const brand = required(args, "--brand");
  const id = required(args, "--source");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(brand)) throw new Error(`--brand must be a lowercase slug, got "${brand}"`);
  const root = `brands/${brand}/videos/${id}`;
  const k = {
    root,
    tts: (i: number) => `${root}/voice/line-${i}.tts.mp3`,
    ttsWords: (i: number) => `${root}/voice/line-${i}.tts.json`,
    line: (i: number) => `${root}/voice/line-${i}.mp3`,
    lineWords: (i: number) => `${root}/voice/line-${i}.json`,
    track: `${root}/voice/track.wav`,
    timeline: `${root}/timeline.json`,
    green: (shot: string) => `${root}/stills/${shot}-green.png`,
    raw: (shot: string) => `${root}/clips/${shot}.raw.mp4`,
    request: (shot: string) => `${root}/clips/${shot}.request.json`,
    clip: (shot: string) => `${root}/clips/${shot}.mp4`,
    take: (shot: string) => `${root}/clips/${shot}.v${Date.now()}.mp4`,
    clips: `${root}/clips.json`,
    edl: `${root}/edl.json`,
    final: `${root}/final.mp4`,
    still: (shot: string) => `brands/${brand}/storyboards/${id}/${shot}.png`,
  };
  const script = AdaptedScriptSchema.parse(await readJson(`brands/${brand}/scripts/${id}.json`, "adapted script"));
  const spec = RecreationSpecSchema.parse(await readJson(`brands/${brand}/sources/specs/${id}.json`, "spec"));
  const character = LockedCharacterSchema.parse(await readJson(`brands/${brand}/character/character.json`, "locked character"));
  const footage = ProductFootageSchema.parse(await readJson(`brands/${brand}/product/footage.json`, "product footage"));
  return { brand, id, k, script, spec, character, footage, jobId: `${brand}-${id}`, ref: (s: string) => `${brand}/${id}/${s}` };
};
type Ctx = Awaited<ReturnType<typeof context>>;

const withTmp = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "katalab-produce-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

// ── voice ──────────────────────────────────────────────────────────────

/** Creator pace: TTS voices read slower than the people in viral reels
 *  (Laura ≈165 wpm against ≈250 in the DbAJ source), so every line is
 *  time-stretched by this factor, pitch preserved. Re-deriving at another
 *  tempo reuses the saved speech; it never calls ElevenLabs again. */
export const DEFAULT_TEMPO = 1.25;

const voice = async (c: Ctx, redo: boolean, tempo: number): Promise<Timeline> => {
  if (!c.character.voice) throw new Error("the character has no voice: run npm run character -- voice-pick first");
  const voiceId = c.character.voice.voiceId;
  // ElevenLabs allows 2 concurrent requests on this plan.
  const lines = c.script.lines;
  for (let i = 0; i < lines.length; i += 2) {
    await Promise.all(
      lines.slice(i, i + 2).map(async (l) => {
        if (!redo && (await storage.exists(c.k.ttsWords(l.index)))) return;
        const { audio, words } = await textToSpeechTimed(voiceId, l.text, { costSink: consoleSink, ref: c.ref(`line-${l.index}`) });
        await storage.putBuffer(c.k.tts(l.index), audio);
        await writeJson(c.k.ttsWords(l.index), { text: l.text, words });
        console.log(`  ✔ line ${l.index} voiced`);
      }),
    );
  }
  // The speech at the video's tempo: stretched audio, word times scaled with it.
  for (const l of lines) {
    if (!redo && (await storage.exists(c.k.lineWords(l.index)))) {
      const done = (await readJson(c.k.lineWords(l.index), "voiced line")) as { tempo?: number };
      if (done.tempo === tempo) continue;
    }
    const tts = (await readJson(c.k.ttsWords(l.index), "speech")) as { words: TimedWord[] };
    await withTmp(async (dir) => {
      const out = path.join(dir, "line.mp3");
      execFileSync("ffmpeg", ["-v", "error", "-y", "-i", await storage.localPath(c.k.tts(l.index)), "-filter:a", `atempo=${tempo}`, "-b:a", "192k", out]);
      await storage.putFile(c.k.line(l.index), out);
      const words = tts.words.map((w) => ({ text: w.text, startSec: w.startSec / tempo, endSec: w.endSec / tempo }));
      await writeJson(c.k.lineWords(l.index), { text: l.text, tempo, durationSec: durationOf(out), words });
    });
  }
  const voiced = await Promise.all(
    lines.map(async (l) => {
      const v = (await readJson(c.k.lineWords(l.index), "voiced line")) as { durationSec: number; words: TimedWord[] };
      return { index: l.index, durationSec: v.durationSec, words: v.words };
    }),
  );
  const timeline = buildTimeline(c.script, c.spec, voiced);
  await writeJson(c.k.timeline, timeline);
  await withTmp(async (dir) => {
    const out = path.join(dir, "track.wav");
    mixVoiceTrack(await Promise.all(timeline.lines.map(async (l) => ({ file: await storage.localPath(c.k.line(l.index)), atSec: l.tlInSec }))), timeline.durationSec, out);
    await storage.putFile(c.k.track, out);
  });
  console.log(`timeline: ${timeline.durationSec.toFixed(1)}s (source ${c.spec.media.durationSec.toFixed(1)}s), ${timeline.shots.length} shots`);
  return timeline;
};

// ── clips ──────────────────────────────────────────────────────────────

type ClipRecord = { kind: ClipKind; key: string; durationSec: number; inSec: number; rate?: number; lipSyncDriftSec?: number };

/** Submit-or-resume: a request id saved before polling means a rerun after a
 *  crash waits for the same generation instead of paying for another. */
const generateOnce = async (c: Ctx, shot: string, endpoint: string, input: Record<string, unknown>, operation: string): Promise<Buffer> => {
  if (await storage.exists(c.k.request(shot))) {
    const saved = (await readJson(c.k.request(shot), "request")) as { requestId: string; endpoint: string };
    if (saved.endpoint === endpoint) {
      try {
        console.log(`  … ${shot}: resuming ${saved.requestId}`);
        return await download(await waitFor(saved.requestId));
      } catch (err) {
        console.log(`  ! ${shot}: saved request unusable (${err instanceof Error ? err.message.slice(0, 120) : err}), submitting again`);
      }
    }
  }
  const bytes = await generate(endpoint, input, {
    costSink: consoleSink,
    ref: c.ref(shot),
    operation,
    onSubmitted: async (requestId) => {
      await writeJson(c.k.request(shot), { requestId, endpoint, at: new Date().toISOString() });
    },
  });
  await storage.remove(c.k.request(shot));
  return bytes;
};

const greenFraction = (file: string): number => {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", "scale=96:-2", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  let green = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) if (raw[i + 1] - Math.max(raw[i], raw[i + 2]) > 60) green++;
  return green / (raw.length / 3);
};

const greenStill = async (c: Ctx, shot: Ctx["script"]["shots"][number]): Promise<string> => {
  if (await storage.exists(c.k.green(shot.shotId))) return storage.localPath(c.k.green(shot.shotId));
  const plan = planFrames(c.script, c.spec, c.character, () => "").find((p) => p.shotId === shot.shotId);
  if (!plan || plan.mode !== "generate") throw new Error(`${shot.shotId}: no frame plan for a green still`);
  const refs = plan.refs.filter((r) => r.role !== "screen");
  const prompt = framePrompt(shot, c.character, refs, DEFAULT_SET, { greenScreen: true });
  const refPaths = await Promise.all(refs.map((r) => storage.localPath(r.key)));
  for (let attempt = 1; attempt <= 2; attempt++) {
    const bytes = await generateImage(prompt, refPaths, refPaths.length, { aspectRatio: "9:16", imageSize: "2K" });
    await consoleSink(googleImageCostEntry(GEMINI_IMAGE_MODEL, 1, "green_still", { ref: c.ref(shot.shotId) }));
    await storage.putBuffer(c.k.green(shot.shotId), bytes);
    const file = await storage.localPath(c.k.green(shot.shotId));
    const g = greenFraction(file);
    if (g > 0.04) {
      // Repaint anything the image model drew onto the green (a fake window,
      // a cursor): the video model would animate it and the key would keep it.
      await withTmp(async (dir) => {
        const cleaned = path.join(dir, "clean.png");
        execFileSync("python3", [greenscreenScript, "--clean-still", file, cleaned], { stdio: ["ignore", "ignore", "inherit"] });
        await storage.putFile(c.k.green(shot.shotId), cleaned);
      });
      return storage.localPath(c.k.green(shot.shotId));
    }
    console.log(`  ! ${shot.shotId}: green still is only ${(g * 100).toFixed(1)}% green, retrying`);
  }
  throw new Error(`${shot.shotId}: could not get a green-screen still`);
};

/** `regenerate` false reuses a provider's earlier output (clips/<shot>.raw.mp4)
 *  when there is one: re-cropping, re-compositing or re-aligning is free. */
const makeClip = async (
  c: Ctx,
  timeline: Timeline,
  shot: Ctx["script"]["shots"][number],
  kind: ClipKind,
  regenerate: boolean,
  /** Where the finished clip goes: a new file for every take, because a
   *  take an EDL (or the editor's undo history, or takes.json) references
   *  must never change under it. */
  outKey = c.k.take(shot.shotId),
): Promise<ClipRecord> => {
  const at = timeline.shots.find((s) => s.shotId === shot.shotId)!;
  const len = at.tlOutSec - at.tlInSec;
  return withTmp(async (dir) => {
    const out = path.join(dir, "clip.mp4");
    let inSec = 0;
    let rate: number | undefined;
    let lipSyncDriftSec: number | undefined;
    let cleanUntil = Infinity;

    if (kind === "footage") {
      const clip = c.footage.clips.find((f) => f.id === shot.footageId)!;
      footageClip(clip, await storage.localPath(clip.key), len, out);
    } else if (kind === "text") {
      textCardClip(len, out);
    } else {
      const raw = path.join(dir, "raw.mp4");
      const reuse = !regenerate && (await storage.exists(c.k.raw(shot.shotId)));
      if (reuse) fs.copyFileSync(await storage.localPath(c.k.raw(shot.shotId)), raw);
      if (kind === "talking") {
        const still = await storage.localPath(c.k.still(shot.shotId));
        const wav = path.join(dir, "voice.wav");
        voiceSegment(await storage.localPath(c.k.track), at.tlInSec, at.tlOutSec, wav, requestSeconds(kind, len));
        const input = {
          prompt: talkingPrompt(shot, c.character.concept.name),
          image_urls: [] as string[],
          audio_urls: [] as string[],
          duration: requestSeconds(kind, len),
          resolution: "720p",
          aspect_ratio: "9:16",
        };
        if (!reuse) {
          input.image_urls = [await uploadFile(still)];
          input.audio_urls = [await uploadFile(wav)];
          fs.writeFileSync(raw, await generateOnce(c, shot.shotId, TALKING_MODEL, input, "talking_shot"));
        }
        const sync = speechAlign(raw, wav, whisperModel(c.script.language));
        inSec = Math.max(0, sync.offsetSec);
        rate = sync.rate;
        lipSyncDriftSec = sync.driftSec;
        if (sync.driftSec > 0.12) console.log(`  ! ${shot.shotId}: lips drift ${sync.driftSec.toFixed(2)}s from the voice; check this shot`);
      } else if (!reuse) {
        const still = kind === "green" ? await greenStill(c, shot) : await storage.localPath(c.k.still(shot.shotId));
        const input = { image_url: await uploadFile(still), prompt: animatePrompt(shot, kind), duration: requestSeconds(kind, len), sound: "off" };
        fs.writeFileSync(raw, await generateOnce(c, shot.shotId, ANIMATE_MODEL, input, kind === "green" ? "device_shot" : "animate_shot"));
      }
      if (!reuse) await storage.putFile(c.k.raw(shot.shotId), raw);
      if (kind === "green") {
        const clip = c.footage.clips.find((f) => f.id === shot.footageId)!;
        const comp = path.join(dir, "comp.mp4");
        const report = execFileSync("python3", [greenscreenScript, raw, await storage.localPath(clip.key), String(clip.startSec), String(clip.endSec), comp], { stdio: ["ignore", "pipe", "inherit"] }).toString();
        normalize(comp, out);
        cleanUntil = Number(report.match(/clean_until_sec ([\d.]+)/)?.[1] ?? Infinity);
        if (cleanUntil < len) console.log(`  ! ${shot.shotId}: the model drew on the screen from ${cleanUntil.toFixed(1)}s; only the clean part plays (slowed to fit)`);
      } else {
        normalize(raw, out, kind === "talking" ? 1 : 0);
      }
    }
    await storage.putFile(outKey, out);
    return { kind, key: outKey, durationSec: Math.min(durationOf(out), cleanUntil), inSec, rate, lipSyncDriftSec };
  });
};

/** What the not-yet-made clips would cost, without spending anything. */
const estimate = async (c: Ctx, timeline: Timeline, todo: { shot: Ctx["script"]["shots"][number]; kind: ClipKind }[], newStills: boolean): Promise<number> => {
  let total = 0;
  for (const { shot, kind } of todo) {
    const at = timeline.shots.find((s) => s.shotId === shot.shotId)!;
    const secs = requestSeconds(kind, at.tlOutSec - at.tlInSec);
    let usd = 0;
    if (kind === "talking") usd = seedanceUsd({ resolution: "720p", aspect_ratio: "9:16", duration: secs });
    if (kind === "animate" || kind === "green") usd = await estimateUsd(ANIMATE_MODEL, { image_url: "https://example.com/x.png", prompt: "x", duration: secs, sound: "off" });
    if (kind === "green" && (newStills || !(await storage.exists(c.k.green(shot.shotId))))) usd += 0.134;
    total += usd;
    console.log(`  ${shot.shotId.padEnd(4)} ${kind.padEnd(8)} ${(at.tlOutSec - at.tlInSec).toFixed(1).padStart(4)}s → ${secs}s  $${usd.toFixed(2)}`);
  }
  console.log(`  total ≈ $${total.toFixed(2)}`);
  return total;
};

const clips = async (c: Ctx, args: string[]) => {
  const timeline = (await readJson(c.k.timeline, "timeline (run voice first)")) as Timeline;
  const only = option(args, "--shots")?.split(",");
  const newStills = args.includes("--new-stills");
  const regenerate = newStills || args.includes("--regenerate");
  const redo = regenerate || args.includes("--redo");
  const records: Record<string, ClipRecord> = (await storage.exists(c.k.clips)) ? ((await readJson(c.k.clips, "clips")) as Record<string, ClipRecord>) : {};

  const todo: { shot: Ctx["script"]["shots"][number]; kind: ClipKind }[] = [];
  for (const shot of c.script.shots) {
    if (only && !only.includes(shot.shotId)) continue;
    if (!redo && records[shot.shotId] && (await storage.exists(records[shot.shotId].key))) continue;
    const kind = planClip(shot);
    if ((kind === "talking" || kind === "animate") && !(await storage.exists(c.k.still(shot.shotId)))) {
      throw new Error(`${shot.shotId} needs its storyboard still: run npm run recreate -- storyboard first`);
    }
    todo.push({ shot, kind });
  }
  console.log(`${todo.length} clip(s) to make:`);
  const paid: typeof todo = [];
  for (const t of todo) if (regenerate || !(await storage.exists(c.k.raw(t.shot.shotId)))) paid.push(t);
  await estimate(c, timeline, paid, newStills);
  if (args.includes("--dry")) return;
  if (regenerate) {
    for (const { shot } of todo) {
      await storage.remove(c.k.request(shot.shotId));
      if (newStills) await storage.remove(c.k.green(shot.shotId));
    }
  }

  const failed: string[] = [];
  const run = async ({ shot, kind }: (typeof todo)[number]) => {
    try {
      records[shot.shotId] = await makeClip(c, timeline, shot, kind, regenerate);
      await writeJson(c.k.clips, records);
      console.log(`  ✔ ${shot.shotId} ${kind}`);
    } catch (err) {
      failed.push(shot.shotId);
      console.log(`  ✘ ${shot.shotId} ${kind}: ${err instanceof Error ? err.message.slice(0, 400) : err}`);
    }
  };
  // A few at a time: providers queue them anyway, and a failure stays local.
  for (let i = 0; i < todo.length; i += 4) await Promise.all(todo.slice(i, i + 4).map(run));
  if (failed.length) throw new Error(`clips failed: ${failed.join(",")} (rerun with --shots ${failed.join(",")})`);
};

// ── render ─────────────────────────────────────────────────────────────

/**
 * Makes the video a project in the app: jobs/<jobId>/job.json (format
 * AI_VIDEO_FORMAT, so the editor and the render route take the EDL as the
 * whole video) and a readable name. Unowned jobs are admin-only (see
 * middleware.ts), which is right for the founder-run pilot.
 */
const publishToEditor = (c: Ctx) => {
  const dir = path.join(repoRoot, "jobs", c.jobId);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, "job.json");
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(manifest, JSON.stringify({ format: AI_VIDEO_FORMAT, bindings: {}, lexicon: [], language: c.script.language }, null, 2));
  }
  // Which brand video this job is, for the editor's per-clip Regenerate.
  fs.writeFileSync(path.join(dir, "ai-video.json"), JSON.stringify({ brand: c.brand, source: c.id }, null, 2));
  const sidecar = path.join(dir, "project.json");
  if (!fs.existsSync(sidecar)) {
    const hook = c.script.lines[0].text.split(/\s+/).slice(0, 6).join(" ");
    fs.writeFileSync(sidecar, JSON.stringify({ name: `${c.brand} · ${hook}…` }, null, 2));
  }
};

const renderVideo = async (c: Ctx, args: string[]) => {
  const timeline = (await readJson(c.k.timeline, "timeline")) as Timeline;
  const records = (await readJson(c.k.clips, "clips")) as Record<string, ClipRecord>;
  // Under generated/: the app only serves a job's assets/, generated/ and
  // derived/ folders (next.config.mjs rewrite, previewAssets.ts allow-list).
  const prefix = `jobs/${c.jobId}/generated`;
  const made = new Map<string, MadeClip>();
  for (const shot of c.script.shots) {
    const r = records[shot.shotId];
    if (!r) throw new Error(`no clip for ${shot.shotId}: run clips first`);
    made.set(shot.shotId, { src: `${prefix}/clips/${path.basename(r.key)}`, file: await storage.localPath(r.key), durationSec: r.durationSec, inSec: r.inSec, rate: r.rate });
  }
  const voiceFiles = new Map<number, VoiceFile>();
  for (const l of timeline.lines) {
    const v = (await readJson(c.k.lineWords(l.index), "voiced line")) as { durationSec: number };
    voiceFiles.set(l.index, { src: `${prefix}/voice/line-${l.index}.mp3`, file: await storage.localPath(c.k.line(l.index)), durationSec: v.durationSec });
  }
  const edl = EdlSchema.parse(compileEdl({ jobId: c.jobId, script: c.script, spec: c.spec, timeline, clips: made, voice: voiceFiles }));
  for (const d of edl.diagnostics) console.log(`  ! ${d}`);

  // The editor saves its edits to artifacts/<jobId>/edl.json. If that file
  // is no longer the one this command last produced, someone edited the
  // video: keep their edits unless told otherwise.
  const dir = artifactsDir(c.jobId);
  const editorEdl = path.join(dir, "edl.json");
  if (fs.existsSync(editorEdl) && (await storage.exists(c.k.edl)) && !args.includes("--discard-edits")) {
    const produced = fs.readFileSync(await storage.localPath(c.k.edl), "utf8");
    if (fs.readFileSync(editorEdl, "utf8") !== produced) {
      throw new Error(`the video was edited in the editor (${editorEdl}); rerun with --discard-edits to replace those edits`);
    }
  }
  const json = JSON.stringify(edl, null, 2);
  await storage.putBuffer(c.k.edl, Buffer.from(json));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(editorEdl, json);
  publishToEditor(c);
  for (const shot of c.script.shots) {
    const m = made.get(shot.shotId)!;
    addTake(c.jobId, shot.shotId, isRegenerable(shot), { ...m, createdAt: new Date().toISOString(), origin: "original" });
  }
  const out = render(edl, dir);
  await storage.putFile(c.k.final, out);
  console.log(`\n✔ ${await storage.localPath(c.k.final)} (${edl.durationSec.toFixed(1)}s)`);
  console.log(`  editor: /jobs/${c.jobId}/edit (admin account)`);
};

/** Only generated shots get new takes: the product's own footage would come out the same. */
const isRegenerable = (shot: Ctx["script"]["shots"][number]) => !["footage", "text"].includes(planClip(shot));

/**
 * The editor's Regenerate button (api/jobs/[jobId]/regenerate-clip): a new
 * take of the one shot a timeline clip was cut from, swapped into the
 * editor's own edl.json so every other edit stays. Each take is kept as its
 * own versioned file, so undo in the editor brings the previous take back.
 * With --dry it only prints `estimate_usd <x>`.
 */
const regenClip = async (args: string[]) => {
  const jobId = required(args, "--job");
  const clipId = required(args, "--clip");
  const metaFile = path.join(repoRoot, "jobs", jobId, "ai-video.json");
  if (!fs.existsSync(metaFile)) throw new Error(`${jobId} is not an AI video`);
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as { brand: string; source: string };
  const c = await context(["--brand", meta.brand, "--source", meta.source]);
  const editorEdl = path.join(artifactsDir(jobId), "edl.json");
  const edl = EdlSchema.parse(JSON.parse(fs.readFileSync(editorEdl, "utf8")));
  const segment = edl.video.find((v) => v.id === clipId);
  if (!segment) throw new Error(`no clip ${clipId} on the timeline`);
  const shot = c.script.shots.find((s) => s.shotId === segment.blockId);
  if (!shot) throw new Error("this clip was added by hand, not generated: there is nothing to regenerate");
  const kind = planClip(shot);
  if (!isRegenerable(shot)) throw new Error("this shot is the product's own footage, not AI: regenerating would give the same clip");
  const timeline = (await readJson(c.k.timeline, "timeline")) as Timeline;

  if (args.includes("--dry")) {
    const usd = await estimate(c, timeline, [{ shot, kind }], false);
    console.log(`estimate_usd ${usd.toFixed(2)}`);
    return;
  }

  await storage.remove(c.k.request(shot.shotId));
  const versionKey = c.k.take(shot.shotId);
  const version = path.basename(versionKey);
  const record = await makeClip(c, timeline, shot, kind, true, versionKey);
  const records = (await readJson(c.k.clips, "clips")) as Record<string, ClipRecord>;
  records[shot.shotId] = record;
  await writeJson(c.k.clips, records);

  const made: MadeClip = {
    src: `jobs/${jobId}/generated/clips/${version}`,
    file: await storage.localPath(versionKey),
    durationSec: record.durationSec,
    inSec: record.inSec,
    rate: record.rate,
  };
  // Re-read: the editor may have saved edits while the shot was generating.
  const latest = EdlSchema.parse(JSON.parse(fs.readFileSync(editorEdl, "utf8")));
  addTake(jobId, shot.shotId, true, { ...made, createdAt: new Date().toISOString(), origin: "regenerated" });
  const swapped = EdlSchema.parse(swapShotClip(latest, shot.shotId, made));
  fs.writeFileSync(editorEdl, JSON.stringify(swapped, null, 2));
  stageAssets(swapped);
  console.log(`regenerated ${clipId} (shot ${shot.shotId}, ${kind})`);
};

const main = async () => {
  const [command, ...args] = process.argv.slice(2);
  if (command === "regen-clip") return regenClip(args);
  if (!["voice", "clips", "render", "all"].includes(command)) {
    console.error(USAGE);
    process.exit(1);
  }
  const c = await context(args);
  const tempo = Number(option(args, "--tempo") ?? DEFAULT_TEMPO);
  if (!(tempo >= 0.8 && tempo <= 1.6)) throw new Error("--tempo must be between 0.8 and 1.6");
  if (command === "voice" || command === "all") await voice(c, args.includes("--redo") && command === "voice", tempo);
  if (command === "clips" || command === "all") await clips(c, args);
  if (command === "render" || (command === "all" && !args.includes("--dry"))) await renderVideo(c, args);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

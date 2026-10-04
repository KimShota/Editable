import "dotenv/config";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { productionKeys } from "../brand/keys";
import { LockedCharacterSchema } from "../character/schemas";
import { consoleSink, type CostSink, googleImageCostEntry } from "../cost/ledger";
import { GEMINI_IMAGE_MODEL, generateImage } from "../pipeline/generation/geminiImage";
import { artifactsDir, repoRoot } from "../pipeline/paths";
import { render, stageAssets } from "../pipeline/render";
import { EdlSchema } from "../pipeline/schemas";
import { AdaptedScriptSchema, ProductFootageSchema, RecreationSpecSchema } from "../recreation/schemas";
import { DEFAULT_SET, framePrompt, planFrames } from "../recreation/storyboard";
import { sourceIdForCard } from "../plan/store";
import { getStorage } from "../storage";
import { type AudioMode, parseAudioMode, readAudioMode } from "./audioMode";
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
  stillClip,
  whisperModel,
  TALKING_MODEL,
  nativeTalkingPrompt,
  spokenShare,
  speechWords,
  talkingPrompt,
  textCardClip,
  voiceSegment,
} from "./clips";
import { compileEdl, type MadeClip, swapShotClip, type VoiceFile } from "./edl";
import { AI_VIDEO_FORMAT } from "./format";
import { appendShotMessages, findPlan, newMessage, readShotChat, updateShotMessage } from "./shotChats";
import { planShotChange } from "./shotChange";
import { addTake, takesForClip } from "./takes";
import { estimateUsd, generate, seedanceUsd, uploadFile, waitFor, download } from "./higgsfield";
import { clipProblem, GREEN_STILL_ATTEMPTS, MIN_GREEN_FRACTION, pickBest, type Quality, RETRY_CAP, usable, worstCaseUsd } from "./retry";
import { alignWords, buildNativeTimeline, buildTimeline, type Timeline } from "./timeline";

/**
 * An adapted script → a finished, editable video (M1 day 5-6), run by hand
 * in the pilot. Every step caches its output under
 * brands/<brand>/videos/<source>/ and is safe to rerun; --redo regenerates.
 *
 *   npm run produce -- voice  --brand <slug> --source <id> | --card <id> [--tempo 1.25] [--redo]
 *       audio mode (brands/<slug>/production.json, or --audio native|revoice): native (the default) skips
 *       ElevenLabs; the timeline follows the source and talking clips speak with the video model's own
 *       audio. revoice voices every line in the locked voice and lip-syncs the clips to it
 *   npm run produce -- clips  --brand <slug> --source <id> [--shots s0,s3] [--redo | --regenerate | --new-stills] [--dry]
 *       --redo rebuilds clips from what the providers already returned (free);
 *       --regenerate pays for new generations; --new-stills also redraws green-screen stills.
 *       A generation that fails its check is retried up to its kind's cap (retry.ts); a shot
 *       that runs out keeps its best attempt or a free fallback and is flagged, never failed
 *   npm run produce -- render --brand <slug> --source <id> [--discard-edits]
 *       also makes the video a project the app's editor opens (jobs/<brand>-<source>)
 *   npm run produce -- regen-clip --job <jobId> --clip <clipId> [--plan <messageId>] [--dry]
 *       a new take of one shot, swapped into the editor's timeline (the Regenerate button);
 *       --plan makes the change a shot-chat plan describes
 *   npm run produce -- shot-chat --job <jobId> --clip <clipId> --message "…"
 *       what the user wants changed in a shot → Claude's plan for a new take, priced, not generated
 *   npm run produce -- all    --brand <slug> --source <id> [--dry]
 *
 *   voice/line-<i>.tts.mp3/.json each line as ElevenLabs spoke it, with word timings
 *   voice/line-<i>.mp3 + .json   the same at the video's tempo (what plays)
 *   voice/track.wav              all lines at their timeline positions
 *   timeline.json                where every line and shot sits
 *   stills/<shot>-green.png      green-screen stills for shots that show the product
 *   clips/<shot>.raw.mp4         what the provider returned (the kept attempt)
 *   clips/<shot>.v<n>.mp4        every attempt at the shot, normalized (and composited)
 *   clips.json                   per shot: kind, file, length, lip-sync offset, flag, other attempts
 *   costs.jsonl                  every paid call for this video, one JSON line each
 *   edl.json, final.mp4          the editable timeline and its render
 */

const USAGE = "usage: npm run produce -- <voice|clips|render|all> --brand <slug> --source <id> [options], or regen-clip|shot-chat --job <id> --clip <id>  (see cli.ts)";

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

/** Every paid call is printed and appended to the video's costs.jsonl, so the
 *  cost per video (retries and re-takes included) is read, not rebuilt. */
const costLog = (key: string): CostSink => {
  let queue = Promise.resolve();
  return (entry) => {
    void consoleSink(entry);
    // One append at a time: shots are made in parallel.
    queue = queue
      .then(async () => {
        const before = (await storage.exists(key)) ? fs.readFileSync(await storage.localPath(key), "utf8") : "";
        await storage.putBuffer(key, Buffer.from(`${before}${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`));
      })
      .catch((err) => console.warn(`cost log: ${err instanceof Error ? err.message : err}`));
    return queue;
  };
};

let lastStamp = 0;
/** Date.now(), but never the same twice: every take is its own file. */
const stamp = () => (lastStamp = Math.max(Date.now(), lastStamp + 1));

const context = async (args: string[]) => {
  const brand = required(args, "--brand");
  // A video is keyed by its plan card (--card); --source names the viral
  // source and, when no --card is given, is its own card. With only --card,
  // the source is looked up in the plan.
  const id = option(args, "--card") ?? required(args, "--source");
  const sourceId = option(args, "--source") ?? (await sourceIdForCard(storage, brand, id));
  if (!/^[a-z0-9][a-z0-9-]*$/.test(brand)) throw new Error(`--brand must be a lowercase slug, got "${brand}"`);
  const k = productionKeys(brand, id, stamp);
  const script = AdaptedScriptSchema.parse(await readJson(`brands/${brand}/scripts/${id}.json`, "adapted script"));
  const spec = RecreationSpecSchema.parse(await readJson(`brands/${brand}/sources/specs/${sourceId}.json`, "spec"));
  const character = LockedCharacterSchema.parse(await readJson(`brands/${brand}/character/character.json`, "locked character"));
  const footage = ProductFootageSchema.parse(await readJson(`brands/${brand}/product/footage.json`, "product footage"));
  // --audio native|revoice overrides the brand's setting for one run.
  const audioOverride = option(args, "--audio");
  const audioMode: AudioMode = audioOverride ? parseAudioMode({ audioMode: audioOverride }) : await readAudioMode(storage, brand);
  return { brand, id, sourceId, k, script, spec, character, footage, audioMode, cost: costLog(k.costs), jobId: `${brand}-${id}`, ref: (s: string) => `${brand}/${id}/${s}` };
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
  if (c.audioMode === "native") {
    // Nothing to voice: the clips speak for themselves, so the source's own times are the timeline.
    const timeline = buildNativeTimeline(c.script, c.spec);
    await writeJson(c.k.timeline, timeline);
    console.log(`native audio: no voice step. timeline: ${timeline.durationSec.toFixed(1)}s (the source's own), ${timeline.shots.length} shots`);
    return timeline;
  }
  if (!c.character.voice) throw new Error("the character has no voice: run npm run character -- voice-pick first");
  const voiceId = c.character.voice.voiceId;
  // ElevenLabs allows 2 concurrent requests on this plan.
  const lines = c.script.lines;
  for (let i = 0; i < lines.length; i += 2) {
    await Promise.all(
      lines.slice(i, i + 2).map(async (l) => {
        if (!redo && (await storage.exists(c.k.ttsWords(l.index)))) return;
        const { audio, words } = await textToSpeechTimed(voiceId, l.text, { costSink: c.cost, ref: c.ref(`line-${l.index}`) });
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

type ClipFile = { key: string; durationSec: number; inSec: number; rate?: number };
type ClipRecord = ClipFile & {
  kind: ClipKind;
  lipSyncDriftSec?: number;
  /** Native audio: the share of the line the clip says. */
  spokenShare?: number;
  /** Native audio: the words the clip says, in clip seconds, for caption timing. */
  heard?: { word: string; startSec: number; endSec: number }[];
  cleanUntilSec?: number;
  /** Why this shot needs a look in the editor (a failed check, a fallback). */
  flag?: string;
  /** The shot's other attempts from the same run, kept as takes. */
  others?: ClipFile[];
};

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
    costSink: c.cost,
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

/** A still whose laptop screen is chroma green, or null when no attempt
 *  came back with enough green to key onto (the caller falls back). */
const greenStill = async (c: Ctx, shot: Ctx["script"]["shots"][number]): Promise<string | null> => {
  if (await storage.exists(c.k.green(shot.shotId))) return storage.localPath(c.k.green(shot.shotId));
  const plan = planFrames(c.script, c.spec, c.character, () => "").find((p) => p.shotId === shot.shotId);
  if (!plan || plan.mode !== "generate") throw new Error(`${shot.shotId}: no frame plan for a green still`);
  const refs = plan.refs.filter((r) => r.role !== "screen");
  const prompt = framePrompt(shot, c.character, refs, DEFAULT_SET, { greenScreen: true });
  const refPaths = await Promise.all(refs.map((r) => storage.localPath(r.key)));
  let best: { bytes: Buffer; green: number } | null = null;
  for (let attempt = 1; attempt <= GREEN_STILL_ATTEMPTS; attempt++) {
    const bytes = await generateImage(prompt, refPaths, refPaths.length, { aspectRatio: "9:16", imageSize: "2K" });
    await c.cost(googleImageCostEntry(GEMINI_IMAGE_MODEL, 1, "green_still", { ref: c.ref(shot.shotId) }));
    const green = await withTmp(async (dir) => {
      const file = path.join(dir, "still.png");
      fs.writeFileSync(file, bytes);
      return greenFraction(file);
    });
    if (!best || green > best.green) best = { bytes, green };
    if (green >= MIN_GREEN_FRACTION) break;
    console.log(`  ! ${shot.shotId}: green still is only ${(green * 100).toFixed(1)}% green${attempt < GREEN_STILL_ATTEMPTS ? ", retrying" : ""}`);
  }
  if (!best || best.green < MIN_GREEN_FRACTION) return null;
  await storage.putBuffer(c.k.green(shot.shotId), best.bytes);
  const file = await storage.localPath(c.k.green(shot.shotId));
  // Repaint anything the image model drew onto the green (a fake window,
  // a cursor): the video model would animate it and the key would keep it.
  await withTmp(async (dir) => {
    const cleaned = path.join(dir, "clean.png");
    execFileSync("python3", [greenscreenScript, "--clean-still", file, cleaned], { stdio: ["ignore", "ignore", "inherit"] });
    await storage.putFile(c.k.green(shot.shotId), cleaned);
  });
  return storage.localPath(c.k.green(shot.shotId));
};

type Attempt = Quality & { problem: string | null; out: string; raw: string; durationSec: number; inSec: number; rate?: number; heard?: ClipRecord["heard"] };

/** A failure as one readable line: a local tool's own last stderr line
 *  (ffmpeg, greenscreen.py) rather than the command it ran. */
const errorText = (err: unknown): string => {
  const stderr = (err as { stderr?: Buffer | string } | null)?.stderr?.toString().trim().split("\n").pop();
  return (stderr || (err instanceof Error ? err.message : String(err))).slice(0, 300);
};

/**
 * One shot's clip. `regenerate` false reuses a provider's earlier output
 * (clips/<shot>.raw.mp4) when there is one: re-cropping, re-compositing or
 * re-aligning is free, and a failed check is only flagged. A paid run makes
 * up to 1 + `retries` attempts, stopping at the first that passes its check
 * (retry.ts), and keeps the best. With `fallback`, a shot left with no usable
 * attempt gets a free stand-in (the product footage, or its storyboard still)
 * and a flag instead of failing the video; without it (the editor's
 * Regenerate, where the current take stays) it throws.
 */
/** The words a talking shot says: the script lines spoken during it. */
const lineOf = (c: Ctx, timeline: Timeline, shotId: string): string => {
  const at = timeline.shots.find((s) => s.shotId === shotId)!;
  return timeline.lines
    .filter((l) => l.tlOutSec > at.tlInSec && l.tlInSec < at.tlOutSec)
    .map((l) => c.script.lines.find((s) => s.index === l.index)?.text ?? "")
    .join(" ");
};

/** The script's own prompt for a talking shot, for this brand's audio mode. */
const talkingPromptFor = (c: Ctx, timeline: Timeline, shot: Ctx["script"]["shots"][number]): string =>
  c.audioMode === "native"
    ? nativeTalkingPrompt(shot, c.character.concept.name, lineOf(c, timeline, shot.shotId), c.character.concept.voiceDescription)
    : talkingPrompt(shot, c.character.concept.name);

const makeClip = async (
  c: Ctx,
  timeline: Timeline,
  shot: Ctx["script"]["shots"][number],
  kind: ClipKind,
  regenerate: boolean,
  opts: {
    retries?: number;
    fallback?: boolean;
    /** The video-model prompt and starting still, when not the script's own
     *  (a change from the shot chat, or a take that came from one). */
    prompt?: string;
    still?: string;
    /** Where a finished clip goes: a new file for every take, because a take
     *  an EDL (or the editor's undo history, or takes.json) references must
     *  never change under it. */
    newKey?: () => string;
  } = {},
): Promise<ClipRecord> => {
  const at = timeline.shots.find((s) => s.shotId === shot.shotId)!;
  const len = at.tlOutSec - at.tlInSec;
  const newKey = opts.newKey ?? (() => c.k.take(shot.shotId));
  const keep = async (file: string): Promise<string> => {
    const key = newKey();
    await storage.putFile(key, file);
    return key;
  };
  const productClip = () => c.footage.clips.find((f) => f.id === shot.footageId)!;

  return withTmp(async (dir) => {
    if (kind === "footage" || kind === "text") {
      const out = path.join(dir, "clip.mp4");
      if (kind === "footage") footageClip(productClip(), await storage.localPath(productClip().key), len, out);
      else textCardClip(len, out);
      return { kind, key: await keep(out), durationSec: durationOf(out), inSec: 0 };
    }

    const fallback = async (why: string, others: ClipFile[] = []): Promise<ClipRecord> => {
      if (!opts.fallback) throw new Error(why);
      const out = path.join(dir, "fallback.mp4");
      if (kind === "green") footageClip(productClip(), await storage.localPath(productClip().key), len, out);
      else stillClip(await storage.localPath(c.k.still(shot.shotId)), len, out);
      const flag = `${why}; using the ${kind === "green" ? "product footage" : "storyboard still"} instead`;
      console.log(`  ! ${shot.shotId}: ${flag}`);
      return { kind, key: await keep(out), durationSec: durationOf(out), inSec: 0, flag, others };
    };

    const footagePath = kind === "green" ? await storage.localPath(productClip().key) : "";
    const wav = path.join(dir, "voice.wav");
    if (kind === "talking" && c.audioMode === "revoice") voiceSegment(await storage.localPath(c.k.track), at.tlInSec, at.tlOutSec, wav, requestSeconds(kind, len));

    /** Provider output → a checked clip on the output canvas. Free. */
    const finish = (raw: string, n: number): Attempt => {
      const out = path.join(dir, `clip-${n}.mp4`);
      if (kind === "talking" && c.audioMode === "native") {
        // The clip's own voice: check it says the line, and keep where each word falls for the captions.
        const expected = lineOf(c, timeline, shot.shotId);
        let heard: NonNullable<Attempt["heard"]> = [];
        try {
          heard = speechWords(raw, whisperModel(c.script.language));
        } catch {
          // No speech could be read: the clip is kept as a last resort, flagged.
        }
        const q: Quality = { spokenShare: heard.length ? spokenShare(expected, heard) : 0 };
        const inSec = heard.length ? Math.max(0, heard[0].startSec - 0.15) : 0;
        normalize(raw, out, 0, true);
        return { ...q, problem: clipProblem(kind, len, q), out, raw, durationSec: durationOf(out), inSec, heard };
      }
      if (kind === "talking") {
        let q: Quality = { lipSyncDriftSec: Infinity };
        let inSec = 0;
        let rate: number | undefined;
        try {
          const sync = speechAlign(raw, wav, whisperModel(c.script.language));
          inSec = Math.max(0, sync.offsetSec);
          rate = sync.rate;
          q = { lipSyncDriftSec: sync.driftSec };
        } catch {
          // No words to align: the clip is kept as a last resort, flagged.
        }
        normalize(raw, out, 1);
        return { ...q, problem: clipProblem(kind, len, q), out, raw, durationSec: durationOf(out), inSec, rate };
      }
      if (kind === "green") {
        const comp = path.join(dir, `comp-${n}.mp4`);
        const clip = productClip();
        const report = execFileSync("python3", [greenscreenScript, raw, footagePath, String(clip.startSec), String(clip.endSec), comp], { stdio: ["ignore", "pipe", "pipe"] }).toString();
        normalize(comp, out);
        const q: Quality = { cleanUntilSec: Number(report.match(/clean_until_sec ([\d.]+)/)?.[1] ?? Infinity) };
        return { ...q, problem: clipProblem(kind, len, q), out, raw, durationSec: Math.min(durationOf(out), q.cleanUntilSec!), inSec: 0 };
      }
      normalize(raw, out);
      return { problem: null, out, raw, durationSec: durationOf(out), inSec: 0 };
    };

    const attempts: Attempt[] = [];
    const errors: string[] = [];
    const reuse = !regenerate && (await storage.exists(c.k.raw(shot.shotId)));
    if (reuse) {
      const raw = path.join(dir, "raw-0.mp4");
      fs.copyFileSync(await storage.localPath(c.k.raw(shot.shotId)), raw);
      try {
        attempts.push(finish(raw, 0));
      } catch (err) {
        errors.push(errorText(err));
      }
    } else {
      // What every attempt sends, uploaded once.
      let input: Record<string, unknown>;
      if (kind === "talking") {
        input = {
          prompt: opts.prompt ?? talkingPromptFor(c, timeline, shot),
          image_urls: [await uploadFile(opts.still ?? (await storage.localPath(c.k.still(shot.shotId))))],
          // Native audio supplies no voice: the model speaks the line in the prompt itself.
          ...(c.audioMode === "revoice" ? { audio_urls: [await uploadFile(wav)] } : {}),
          duration: requestSeconds(kind, len),
          resolution: "720p",
          aspect_ratio: "9:16",
        };
      } else {
        let still: string | null;
        try {
          still = opts.still ?? (kind === "green" ? await greenStill(c, shot) : await storage.localPath(c.k.still(shot.shotId)));
        } catch (err) {
          return fallback(`no green-screen still (${errorText(err)})`);
        }
        if (!still) return fallback("no green-screen still came back green enough to key");
        input = { image_url: await uploadFile(still), prompt: opts.prompt ?? animatePrompt(shot, kind), duration: requestSeconds(kind, len), sound: "off" };
      }
      const tries = 1 + (opts.retries ?? 0);
      for (let n = 1; n <= tries; n++) {
        const more = n < tries ? `, retrying (${n}/${tries - 1})` : "";
        const raw = path.join(dir, `raw-${n}.mp4`);
        try {
          const operation = kind === "talking" ? "talking_shot" : kind === "green" ? "device_shot" : "animate_shot";
          fs.writeFileSync(raw, await generateOnce(c, shot.shotId, kind === "talking" ? TALKING_MODEL : ANIMATE_MODEL, input, operation));
          const a = finish(raw, n);
          attempts.push(a);
          if (!a.problem) break;
          console.log(`  ! ${shot.shotId}: ${a.problem}${more}`);
        } catch (err) {
          errors.push(errorText(err));
          console.log(`  ! ${shot.shotId}: attempt ${n} failed: ${errorText(err)}${more}`);
        }
      }
    }

    // Without a fallback to stand in, a paid clip is kept however it came out (flagged).
    const best = pickBest(kind, attempts.filter((a) => usable(kind, len, a))) ?? (opts.fallback ? undefined : pickBest(kind, attempts));
    const others: ClipFile[] = [];
    for (const a of attempts) {
      if (a !== best) others.push({ key: await keep(a.out), durationSec: a.durationSec, inSec: a.inSec, rate: a.rate });
    }
    if (!best) {
      const why = attempts.length ? (attempts[attempts.length - 1].problem ?? "no usable attempt") : (errors[errors.length - 1] ?? "no clip came back");
      return fallback(why, others);
    }
    if (!reuse) await storage.putFile(c.k.raw(shot.shotId), best.raw);
    const record: ClipRecord = { kind, key: await keep(best.out), durationSec: best.durationSec, inSec: best.inSec, rate: best.rate, others };
    if (best.lipSyncDriftSec !== undefined && Number.isFinite(best.lipSyncDriftSec)) record.lipSyncDriftSec = best.lipSyncDriftSec;
    if (best.spokenShare !== undefined) record.spokenShare = best.spokenShare;
    if (best.heard) record.heard = best.heard;
    if (best.cleanUntilSec !== undefined && Number.isFinite(best.cleanUntilSec)) record.cleanUntilSec = best.cleanUntilSec;
    if (best.problem) {
      record.flag = reuse ? `${best.problem} (rerun with --regenerate --shots ${shot.shotId} to retry)` : `${best.problem}, after ${attempts.length} attempt(s)`;
      console.log(`  ! ${shot.shotId}: keeping it: ${record.flag}`);
    }
    return record;
  });
};

/** What the not-yet-made clips would cost on a first pass, without spending
 *  anything; with `retries`, also the most they can cost if every allowed
 *  retry is used (retry.ts), so a run's ceiling is known before it starts. */
const estimate = async (
  c: Ctx,
  timeline: Timeline,
  todo: { shot: Ctx["script"]["shots"][number]; kind: ClipKind }[],
  opts: { newStills: boolean; retries: boolean },
): Promise<number> => {
  let total = 0;
  let worst = 0;
  for (const { shot, kind } of todo) {
    const at = timeline.shots.find((s) => s.shotId === shot.shotId)!;
    const secs = requestSeconds(kind, at.tlOutSec - at.tlInSec);
    let clipUsd = 0;
    if (kind === "talking") clipUsd = seedanceUsd({ resolution: "720p", aspect_ratio: "9:16", duration: secs });
    if (kind === "animate" || kind === "green") clipUsd = await estimateUsd(ANIMATE_MODEL, { image_url: "https://example.com/x.png", prompt: "x", duration: secs, sound: "off" });
    const stillUsd =
      kind === "green" && (opts.newStills || !(await storage.exists(c.k.green(shot.shotId)))) ? googleImageCostEntry(GEMINI_IMAGE_MODEL, 1, "green_still").usd : 0;
    const usd = clipUsd + stillUsd;
    const most = opts.retries ? worstCaseUsd(kind, clipUsd, stillUsd) : usd;
    total += usd;
    worst += most;
    const ceiling = most > usd + 1e-9 ? `  (up to $${most.toFixed(2)} with retries)` : "";
    console.log(`  ${shot.shotId.padEnd(4)} ${kind.padEnd(8)} ${(at.tlOutSec - at.tlInSec).toFixed(1).padStart(4)}s → ${secs}s  $${usd.toFixed(2)}${ceiling}`);
  }
  console.log(`  total ≈ $${total.toFixed(2)}${opts.retries ? `, at most $${worst.toFixed(2)} if every retry is used` : ""}`);
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
  await estimate(c, timeline, paid, { newStills, retries: true });
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
      records[shot.shotId] = await makeClip(c, timeline, shot, kind, regenerate, { retries: RETRY_CAP[kind], fallback: true });
      await writeJson(c.k.clips, records);
      console.log(`  ${records[shot.shotId].flag ? "⚑" : "✔"} ${shot.shotId} ${kind}`);
    } catch (err) {
      failed.push(shot.shotId);
      console.log(`  ✘ ${shot.shotId} ${kind}: ${err instanceof Error ? err.message.slice(0, 400) : err}`);
    }
  };
  // A few at a time: providers queue them anyway, and a failure stays local.
  for (let i = 0; i < todo.length; i += 4) await Promise.all(todo.slice(i, i + 4).map(run));
  const flagged = todo.map((t) => t.shot.shotId).filter((id) => records[id]?.flag);
  if (flagged.length) {
    console.log(`\nshots to look at in the editor (every attempt is a take there):`);
    for (const id of flagged) console.log(`  ⚑ ${id}: ${records[id].flag}`);
  }
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
  fs.writeFileSync(path.join(dir, "ai-video.json"), JSON.stringify({ brand: c.brand, source: c.id, card: c.id, sourceId: c.sourceId }, null, 2));
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
  // Native audio: the shots that speak play their own clip audio, and there is no voice track.
  let speaking: Set<string> | undefined;
  if (c.audioMode === "native") {
    speaking = new Set(c.script.shots.filter((s) => planClip(s) === "talking" && !records[s.shotId]?.flag?.includes("instead")).map((s) => s.shotId));
    // Captions follow what each clip said: the script's words at the heard times.
    for (const l of timeline.lines) {
      const at = timeline.shots.find((s) => s.tlInSec <= l.tlInSec + 1e-6 && l.tlInSec < s.tlOutSec);
      const r = at && speaking.has(at.shotId) ? records[at.shotId] : undefined;
      if (!at || !r?.heard?.length) continue;
      const heard = r.heard
        .map((w) => ({ startSec: at.tlInSec + w.startSec - r.inSec, endSec: at.tlInSec + w.endSec - r.inSec }))
        .filter((w) => w.endSec > at.tlInSec && w.startSec < at.tlOutSec);
      const words = alignWords(c.script.lines.find((s) => s.index === l.index)?.text ?? "", heard);
      if (words) l.words = words;
    }
  } else {
    for (const l of timeline.lines) {
      const v = (await readJson(c.k.lineWords(l.index), "voiced line")) as { durationSec: number };
      voiceFiles.set(l.index, { src: `${prefix}/voice/line-${l.index}.mp3`, file: await storage.localPath(c.k.line(l.index)), durationSec: v.durationSec });
    }
  }
  const edl = EdlSchema.parse(compileEdl({ jobId: c.jobId, script: c.script, spec: c.spec, timeline, clips: made, voice: voiceFiles, speaking }));
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
    const createdAt = new Date().toISOString();
    addTake(c.jobId, shot.shotId, isRegenerable(shot), { ...m, createdAt, origin: "original" });
    // The attempts a run did not keep, so any of them can still be picked.
    for (const o of records[shot.shotId].others ?? []) {
      addTake(c.jobId, shot.shotId, isRegenerable(shot), {
        src: `${prefix}/clips/${path.basename(o.key)}`,
        file: await storage.localPath(o.key),
        durationSec: o.durationSec,
        inSec: o.inSec,
        rate: o.rate,
        createdAt,
        origin: "retry",
      });
    }
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
/** The AI shot a timeline clip was cut from, and the take of it on the timeline. */
const clipContext = async (args: string[]) => {
  const jobId = required(args, "--job");
  const clipId = required(args, "--clip");
  const metaFile = path.join(repoRoot, "jobs", jobId, "ai-video.json");
  if (!fs.existsSync(metaFile)) throw new Error(`${jobId} is not an AI video`);
  // `source` is the card id in files written before cards existed (a card
  // is its own source then); `card` is set on newer ones.
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as { brand: string; source: string; card?: string; sourceId?: string };
  const c = await context(["--brand", meta.brand, "--card", meta.card ?? meta.source, ...(meta.sourceId ? ["--source", meta.sourceId] : [])]);
  const editorEdl = path.join(artifactsDir(jobId), "edl.json");
  const edl = EdlSchema.parse(JSON.parse(fs.readFileSync(editorEdl, "utf8")));
  const segment = edl.video.find((v) => v.id === clipId);
  if (!segment) throw new Error(`no clip ${clipId} on the timeline`);
  const shot = c.script.shots.find((s) => s.shotId === segment.blockId);
  if (!shot) throw new Error("this clip was added by hand, not generated: there is nothing to regenerate");
  const kind = planClip(shot);
  if (!isRegenerable(shot)) throw new Error("this shot is the product's own footage, not AI: regenerating would give the same clip");
  const timeline = (await readJson(c.k.timeline, "timeline")) as Timeline;
  // The take on the timeline: a change builds on its prompt and still.
  const takes = takesForClip(jobId, clipId);
  const take = takes.takes.find((t) => t.id === takes.currentTakeId);
  const takeFile = take?.file ?? edl.assets[segment.src];
  if (!takeFile) throw new Error(`no file for clip ${clipId}`);
  return { jobId, clipId, c, editorEdl, segment, shot, kind, timeline, take, takeFile };
};
type ClipCtx = Awaited<ReturnType<typeof clipContext>>;

/** The prompt and still the take on the timeline was made from: its own when
 *  it came from a change, else the script's. */
const basePromptAndStill = async (x: ClipCtx): Promise<{ prompt: string; still: string }> => {
  const prompt = x.take?.prompt ?? (x.kind === "talking" ? talkingPromptFor(x.c, x.timeline, x.shot) : animatePrompt(x.shot, x.kind));
  if (x.take?.still) return { prompt, still: x.take.still };
  const green = x.kind === "green" && (await storage.exists(x.c.k.green(x.shot.shotId)));
  return { prompt, still: await storage.localPath(green ? x.c.k.green(x.shot.shotId) : x.c.k.still(x.shot.shotId)) };
};

/** A still edited for a change (Gemini, the current still as the image to
 *  edit). Saved as its own file beside the video's stills, never over them. */
const editStill = async (x: ClipCtx, from: string, instruction: string): Promise<string> => {
  const green = x.kind === "green";
  const prompt = [
    `Edit this image: ${instruction}.`,
    "Keep everything else exactly as it is: the same person, face, hair, outfit, room, lighting, framing and photographic style.",
    green ? "The laptop screen must stay a flat, solid chroma green with nothing on it." : "",
    "No text, captions or logos.",
  ]
    .filter(Boolean)
    .join(" ");
  const bytes = await generateImage(prompt, [from], 1, { aspectRatio: "9:16", imageSize: "2K" }).catch((err: Error) => {
    if (/API error 402/.test(err.message)) throw new Error("the still edit needs Gemini, whose prepaid credits are used up (top up at ai.studio), or ask for the change without editing the still");
    throw err;
  });
  await x.c.cost(googleImageCostEntry(GEMINI_IMAGE_MODEL, 1, "still_edit", { ref: x.c.ref(x.shot.shotId) }));
  const key = `${x.c.k.root}/stills/${x.shot.shotId}.v${stamp()}.png`;
  await storage.putBuffer(key, bytes);
  const file = await storage.localPath(key);
  if (green) {
    const g = greenFraction(file);
    if (g < MIN_GREEN_FRACTION) throw new Error(`the edited still lost its green screen (${(g * 100).toFixed(1)}% green): try asking for the change without touching the laptop`);
    await withTmp(async (dir) => {
      const cleaned = path.join(dir, "clean.png");
      execFileSync("python3", [greenscreenScript, "--clean-still", file, cleaned], { stdio: ["ignore", "ignore", "inherit"] });
      await storage.putFile(key, cleaned);
    });
  }
  return storage.localPath(key);
};

const stillEditUsd = () => googleImageCostEntry(GEMINI_IMAGE_MODEL, 1, "still_edit").usd;

/**
 * The editor's Regenerate (api/jobs/[jobId]/regenerate-clip): a new take of
 * the one shot a timeline clip was cut from, swapped into the editor's own
 * edl.json so every other edit stays. Each take is kept as its own versioned
 * file, so undo in the editor brings the previous take back. It builds on
 * the take on the timeline (its prompt and still); with --plan, on a change
 * from the shot chat (a new prompt and/or an edited still). With --dry it
 * only prints `estimate_usd <x>`.
 */
const regenClip = async (args: string[]) => {
  const x = await clipContext(args);
  const { c, shot, kind, jobId, clipId } = x;
  const planId = option(args, "--plan");
  const plan = planId ? findPlan(jobId, shot.shotId, planId) : null;
  const change = plan?.message.plan;

  if (args.includes("--dry")) {
    const usd = (await estimate(c, x.timeline, [{ shot, kind }], { newStills: false, retries: false })) + (change?.stillEdit ? stillEditUsd() : 0);
    console.log(`estimate_usd ${usd.toFixed(2)}`);
    return;
  }

  // Undefined keeps the script's own prompt/still (makeClip's defaults).
  let prompt = x.take?.prompt;
  let still = x.take?.still;
  if (change?.motion) prompt = change.motion;
  if (change?.stillEdit) still = await editStill(x, (await basePromptAndStill(x)).still, change.stillEdit);

  await storage.remove(c.k.request(shot.shotId));
  const versionKey = c.k.take(shot.shotId);
  const version = path.basename(versionKey);
  // One attempt, no fallback: its price was confirmed up front, and on
  // failure the editor keeps the take it has. A failed check is flagged.
  const record = await makeClip(c, x.timeline, shot, kind, true, { newKey: () => versionKey, prompt, still });
  if (record.flag) console.log(`  ! ${shot.shotId}: ${record.flag}`);
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
  const latest = EdlSchema.parse(JSON.parse(fs.readFileSync(x.editorEdl, "utf8")));
  const take = addTake(jobId, shot.shotId, true, {
    ...made,
    createdAt: new Date().toISOString(),
    origin: "regenerated",
    prompt,
    still,
    request: plan?.request,
    label: change?.label,
  });
  if (plan) updateShotMessage(jobId, shot.shotId, plan.message.id, { takeId: take.id });
  const swapped = EdlSchema.parse(swapShotClip(latest, shot.shotId, made));
  fs.writeFileSync(x.editorEdl, JSON.stringify(swapped, null, 2));
  stageAssets(swapped);
  console.log(`regenerated ${clipId} (shot ${shot.shotId}, ${kind})`);
};

/**
 * One turn of a shot's change chat (api/jobs/[jobId]/shot-chat): the user's
 * request → Claude's plan for a new take, priced but not generated (the
 * editor's Generate runs regen-clip --plan). Prints `RESULT <json>` with the
 * two new messages.
 */
const shotChat = async (args: string[]) => {
  const x = await clipContext(args);
  const { c, shot, kind } = x;
  const request = required(args, "--message").trim().slice(0, 1000);
  if (!request) throw new Error("say what you want to change");
  const base = await basePromptAndStill(x);
  const history = readShotChat(x.jobId, shot.shotId);
  const at = x.timeline.shots.find((s) => s.shotId === shot.shotId)!;
  // A talking shot's line: the script lines spoken during it.
  const line =
    kind === "talking"
      ? x.timeline.lines
          .filter((l) => l.tlOutSec > at.tlInSec && l.tlInSec < at.tlOutSec)
          .map((l) => c.script.lines.find((s) => s.index === l.index)?.text ?? "")
          .join(" ")
      : undefined;

  const { plan } = await withTmp(async (dir) => {
    // Small jpgs for Claude: the still, and the take at its start, middle and end.
    const still = path.join(dir, "still.jpg");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", base.still, "-vf", "scale=540:-2", "-frames:v", "1", still]);
    const takeSec = durationOf(x.takeFile);
    const frames = [0.1, 0.5, 0.9].map((f, i) => {
      const out = path.join(dir, `frame-${i}.jpg`);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", (takeSec * f).toFixed(2), "-i", x.takeFile, "-frames:v", "1", "-vf", "scale=360:-2", out]);
      return out;
    });
    return planShotChange(
      { kind, shotId: shot.shotId, action: shot.action, durationSec: at.tlOutSec - at.tlInSec, line, characterName: c.character.concept.name, currentPrompt: base.prompt, still, frames },
      history,
      request,
      { costSink: c.cost, ref: c.ref(shot.shotId) },
    );
  });
  const estimateUsd =
    plan.action === "regenerate"
      ? Math.round(((await estimate(c, x.timeline, [{ shot, kind }], { newStills: false, retries: false })) + (plan.stillEdit ? stillEditUsd() : 0)) * 100) / 100
      : undefined;
  const messages = [newMessage({ role: "user", text: request }), newMessage({ role: "assistant", text: plan.reply, plan: { ...plan, estimateUsd } })];
  appendShotMessages(x.jobId, shot.shotId, messages);
  console.log(`RESULT ${JSON.stringify({ shotId: shot.shotId, messages })}`);
};

const main = async () => {
  const [command, ...args] = process.argv.slice(2);
  if (command === "regen-clip") return regenClip(args);
  if (command === "shot-chat") return shotChat(args);
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

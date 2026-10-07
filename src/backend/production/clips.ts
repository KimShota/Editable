import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdaptedScript, ProductFootage } from "../recreation/schemas";

/**
 * One clip per shot, made the cheapest way that keeps the shot honest:
 *
 *   footage   the product UI filling the frame: a crop of the real recording, no generation
 *   talking   the character speaking a line: Seedance, driven by the line's own audio (lip-sync)
 *   green     a device showing the product: Kling animates a still whose screen is chroma
 *             green, then greenscreen.py keys the real recording onto it frame by frame
 *   animate   anything else (hands on a laptop, b-roll): Kling animates the storyboard still
 *   text      a text card: a plain background, the text itself is an editable overlay
 *
 * Every clip is normalized to the output canvas; the timeline (EDL) picks
 * which part of it plays, so a clip can be trimmed or extended in the editor.
 */

export const WIDTH = 1080;
export const HEIGHT = 1920;
export const FPS = 30;

export const TALKING_MODEL = "bytedance/seedance-2.5/reference-to-video";
export const ANIMATE_MODEL = "kling-video/v3.0/std/image-to-video";
/** The models' own shortest clips. */
export const TALKING_MIN_SEC = 4;
export const ANIMATE_MIN_SEC = 3;

export type ClipKind = "footage" | "talking" | "green" | "animate" | "text";

/**
 * How a shot is made. `speaks` is whether any line is spoken during it (see
 * speakingShots): a talking clip (Seedance, ~$0.46/s, 4s minimum) is only paid
 * for when there are words to say. A character shot with none, like a silent
 * reaction over music, is a silent animated clip from its still (~$0.07/s).
 */
export const planClip = (shot: AdaptedScript["shots"][number], speaks: boolean): ClipKind => {
  if (shot.treatment === "text_card") return "text";
  if (shot.treatment === "character_talking") return speaks ? "talking" : "animate";
  // Any shot with product footage plays the footage itself, filling the frame. The green screen
  // (a generated device with the footage keyed onto it) is off for now: it distorts the picture
  // too often. Its code stays (greenscreen.py, retry.ts) for when it is turned back on.
  if (shot.footageId) return "footage";
  return "animate";
};

/** Whole seconds a provider is asked for: enough to cover the shot, at least its minimum. */
export const requestSeconds = (kind: ClipKind, shotSec: number): number =>
  Math.max(kind === "talking" ? TALKING_MIN_SEC : ANIMATE_MIN_SEC, Math.ceil(shotSec + 0.25));

export const talkingPrompt = (shot: AdaptedScript["shots"][number], name: string): string =>
  `${name}, the woman in image 1, talks straight to the phone camera, saying exactly the words of audio 1 with precise lip-sync; audio 1 is her own voice. ` +
  `${shot.action} Same face, hair, outfit and room as image 1. Handheld phone camera, natural light, like a creator filming a selfie video. ` +
  "No other speech, no music, no captions or on-screen text.";

/**
 * The talking shot when the clip speaks for itself (audio mode "native"): the
 * video model generates her voice with the clip, so the words go in the prompt
 * and no audio is supplied. Her voice is described, so it stays close from
 * clip to clip.
 */
export const nativeTalkingPrompt = (shot: AdaptedScript["shots"][number], name: string, line: string, voice: string): string =>
  line.trim()
    ? `${name}, the woman in image 1, talks straight to the phone camera and says exactly these words, clearly, at a natural relaxed conversational pace, not rushed, with precise lip-sync: "${line}" ` +
      `Her voice: ${voice} ${shot.action} Same face, hair, outfit and room as image 1. Handheld phone camera, natural light, like a creator filming a selfie video. ` +
      "She says only those words, once. No music, no captions, logos, icons or on-screen text."
    : `${name}, the woman in image 1, does not speak in this shot. ${shot.action} Same face, hair, outfit and room as image 1. Handheld phone camera, natural light, like a creator filming a selfie video. ` +
      "No speech, no music, no captions, logos, icons or on-screen text.";

/**
 * A green-screen shot's prompt never mentions what is on the screen: asked
 * to show "typing a search", the video model draws a fake search bar onto the
 * green, which the key then keeps. It only gets the body's motion.
 */
const GREEN_MOTION: Partial<Record<AdaptedScript["shots"][number]["treatment"], string>> = {
  device_closeup: "Close-up of a hand on a MacBook: the fingers move naturally over the keyboard and trackpad, a small tap or click.",
  character_with_device: "She holds the MacBook toward the camera as in the image and smiles; the camera slowly pushes in.",
};

export const animatePrompt = (shot: AdaptedScript["shots"][number], kind: ClipKind): string =>
  [
    "Filmed on a phone, natural subtle handheld motion.",
    kind === "green" ? (GREEN_MOTION[shot.treatment] ?? "Small natural movement.") : shot.action,
    // A character_talking shot only animates when it has no words: she reacts, she does not talk.
    shot.treatment === "character_talking" ? "She does not speak: her lips stay still apart from her expression." : "",
    kind === "green" ? "The laptop display stays a flat, solid green the entire time: nothing appears on it, no windows, text or cursor." : "",
    "Keep every face, hand and object consistent. No captions or added text.",
  ]
    .filter(Boolean)
    .join(" ");

const ffmpeg = (args: string[]): void => {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
};

export const durationOf = (file: string): number =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());

/** Any generated clip → the output canvas (cover-cropped), constant frame
 *  rate, no audio unless `keepAudio` (native clips speak). `holdSec` repeats the last frame: a lip-synced clip must
 *  play at its sync rate, so a short one holds its end (the silent tail
 *  after the last word) rather than slowing down and losing the sync. */
export const normalize = (input: string, output: string, holdSec = 0, keepAudio = false): void =>
  ffmpeg([
    "-i", input, ...(keepAudio ? [] : ["-an"]),
    "-vf", `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},fps=${FPS}${holdSec > 0 ? `,tpad=stop_mode=clone:stop_duration=${holdSec}` : ""}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", ...(keepAudio ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"] : []), output,
  ]);

/**
 * A screen recording framed for a vertical video: the clip's crop box (the
 * part of the screen that matters) scaled to the full width, over a blurred,
 * darkened fill of the same footage. A recording shorter than the shot plays
 * slower (at most half speed), then holds its last frame.
 */
export const footageClip = (clip: ProductFootage["clips"][number], footagePath: string, shotSec: number, output: string): void => {
  const len = clip.endSec - clip.startSec;
  const slow = Math.min(2, Math.max(1, shotSec / len));
  const hold = Math.max(0, shotSec - len * slow) + 0.5;
  const box = clip.crop ?? { x: 0.2, y: 0, w: 0.6, h: 1 };
  const fg = `crop=iw*${box.w}:ih*${box.h}:iw*${box.x}:ih*${box.y},scale=${WIDTH}:-2`;
  const bg = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},boxblur=40:2,eq=brightness=-0.25`;
  ffmpeg([
    "-ss", String(clip.startSec), "-to", String(clip.endSec), "-i", footagePath,
    "-filter_complex",
    `[0:v]setpts=${slow}*PTS,fps=${FPS},tpad=stop_mode=clone:stop_duration=${hold.toFixed(2)},split[a][b];[a]${bg}[bg];[b]${fg}[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]`,
    "-map", "[v]", "-an", "-c:v", "libx264", "-crf", "18", output,
  ]);
};

/** A plain background for a text card; the words are an overlay on the timeline. */
export const textCardClip = (shotSec: number, output: string, color = "black"): void =>
  ffmpeg(["-f", "lavfi", "-i", `color=c=${color}:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${(shotSec + 0.5).toFixed(2)}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", output]);

/** A still as a clip, with a slow 5% push-in so it doesn't read as frozen: the
 *  free fallback for a shot whose generations all failed. Drawn at twice the
 *  size before zooming, so the push-in moves smoothly instead of in pixel steps. */
export const stillClip = (still: string, shotSec: number, output: string): void => {
  const frames = Math.ceil((shotSec + 0.5) * FPS);
  ffmpeg([
    "-loop", "1", "-framerate", String(FPS), "-t", (frames / FPS).toFixed(3), "-i", still,
    "-vf", `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},scale=${WIDTH * 2}:${HEIGHT * 2},` +
      `zoompan=z='1+0.05*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS}`,
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", output,
  ]);
};

/** Word start times in a file's speech, from whisper.cpp (the same binary and
 *  models the transcribe stage uses). */
const wordStarts = (file: string, model: string): { word: string; atSec: number }[] => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "katalab-words-"));
  try {
    const wav = path.join(dir, "a.wav");
    ffmpeg(["-i", file, "-vn", "-ac", "1", "-ar", "16000", wav]);
    execFileSync("whisper-cli", ["-m", model, "-f", wav, "-ml", "1", "-oj", "-of", path.join(dir, "w"), "-np"], { stdio: "ignore" });
    const json = JSON.parse(fs.readFileSync(path.join(dir, "w.json"), "utf8")) as { transcription: { text: string; offsets: { from: number } }[] };
    return json.transcription
      .map((t) => ({ word: t.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""), atSec: t.offsets.from / 1000 }))
      .filter((w) => w.word.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/** Every word a file's speech holds, with start and end seconds (whisper.cpp). */
export const speechWords = (file: string, model: string): { word: string; startSec: number; endSec: number }[] => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "katalab-heard-"));
  try {
    const wav = path.join(dir, "a.wav");
    ffmpeg(["-i", file, "-vn", "-ac", "1", "-ar", "16000", wav]);
    execFileSync("whisper-cli", ["-m", model, "-f", wav, "-ml", "1", "-oj", "-of", path.join(dir, "w"), "-np"], { stdio: "ignore" });
    const json = JSON.parse(fs.readFileSync(path.join(dir, "w.json"), "utf8")) as { transcription: { text: string; offsets: { from: number; to: number } }[] };
    return json.transcription
      .map((t) => ({ word: t.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""), startSec: t.offsets.from / 1000, endSec: t.offsets.to / 1000 }))
      .filter((w) => w.word.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/** Share of the expected line's words the clip's speech contains, in order. */
export const spokenShare = (expected: string, heard: { word: string }[]): number => {
  const want = expected.toLowerCase().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  if (want.length === 0) return 1;
  let at = 0;
  let hit = 0;
  for (const w of want) {
    const i = heard.findIndex((h, k) => k >= at && h.word === w);
    if (i !== -1) {
      hit++;
      at = i + 1;
    }
  }
  return hit / want.length;
};

/** Least-squares line y = rate·x + offset. */
const fitLine = (pairs: [number, number][]): { rate: number; offset: number; rms: number } => {
  const n = pairs.length;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
  const my = pairs.reduce((s, p) => s + p[1], 0) / n;
  const sxx = pairs.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  const sxy = pairs.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0);
  const rate = sxx > 0 ? sxy / sxx : 1;
  const offset = my - rate * mx;
  const rms = Math.sqrt(pairs.reduce((s, p) => s + (p[1] - (rate * p[0] + offset)) ** 2, 0) / n);
  return { rate, offset, rms };
};

/**
 * How a lip-synced clip lines up with our own voice. The lip-sync model
 * re-performs the line rather than playing our audio: the words are ours,
 * but it may start later and speak slower (asked for 6 s of video, it
 * stretches 5 s of speech to fill it). Both are transcribed with word
 * timings, the same words are paired in order, and a straight line through
 * the pairs gives `rate` (clip seconds per our second) and `offsetSec`
 * (clip time of our t=0). Playing the clip at `rate` from `offsetSec` puts
 * its mouth on our voice; `driftSec` is how far the words still miss (rms).
 */
export const speechAlign = (clip: string, reference: string, model: string): { offsetSec: number; rate: number; driftSec: number; pairedWords: number } => {
  const ours = wordStarts(reference, model);
  const theirs = wordStarts(clip, model);
  const pairs: [number, number][] = [];
  let j = 0;
  for (const w of ours) {
    // The next clip word that is the same word (or starts the same way:
    // whisper spells a name differently from one take to the next).
    for (let k = j; k < Math.min(theirs.length, j + 4); k++) {
      if (theirs[k].word === w.word || theirs[k].word.slice(0, 3) === w.word.slice(0, 3)) {
        pairs.push([w.atSec, theirs[k].atSec]);
        j = k + 1;
        break;
      }
    }
  }
  if (pairs.length < 4) throw new Error(`lip-sync: only ${pairs.length} words of the line were found in the clip`);
  const fit = fitLine(pairs);
  return { offsetSec: fit.offset, rate: Math.min(1.6, Math.max(0.6, fit.rate)), driftSec: fit.rms, pairedWords: pairs.length };
};

/** whisper.cpp model for a language: the small English one, else the multilingual one. */
export const whisperModel = (language: string): string => path.join(process.cwd(), "models", language.startsWith("en") ? "ggml-base.en.bin" : "ggml-medium.bin");

/** The voice track's audio under one shot, as the WAV a lip-sync model
 *  takes, padded with silence to `padToSec` (the clip length requested) so
 *  the model has no reason to stretch the speech to fill the clip. */
export const voiceSegment = (voiceTrack: string, fromSec: number, toSec: number, output: string, padToSec?: number): void =>
  ffmpeg([
    "-ss", fromSec.toFixed(3), "-to", toSec.toFixed(3), "-i", voiceTrack,
    ...(padToSec ? ["-af", `apad=whole_dur=${padToSec.toFixed(3)}`] : []),
    "-ac", "1", "-ar", "44100", output,
  ]);

/**
 * All lines on one track, each at its timeline position: what plays under
 * the whole video and what talking shots are lip-synced to.
 */
export const mixVoiceTrack = (lines: { file: string; atSec: number }[], durationSec: number, output: string): void => {
  const inputs = lines.flatMap((l) => ["-i", l.file]);
  const delays = lines.map((l, i) => `[${i}:a]adelay=${Math.round(l.atSec * 1000)}:all=1[d${i}]`).join(";");
  const mix = `${lines.map((_, i) => `[d${i}]`).join("")}amix=inputs=${lines.length}:normalize=0,apad,atrim=0:${durationSec.toFixed(3)}[a]`;
  ffmpeg([...inputs, "-filter_complex", `${delays};${mix}`, "-map", "[a]", "-ac", "1", "-ar", "44100", output]);
};

/** Resolved from the repo root (process.cwd(), as pipeline/paths.ts does):
 *  this module is also bundled into the app, where __dirname is virtual. */
export const greenscreenScript = path.join(process.cwd(), "src", "backend", "production", "greenscreen.py");

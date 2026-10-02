import { execFileSync } from "node:child_process";
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

export const planClip = (shot: AdaptedScript["shots"][number]): ClipKind => {
  if (shot.treatment === "text_card") return "text";
  if (shot.treatment === "character_talking") return "talking";
  if (shot.footageId && shot.treatment === "screen_fill") return "footage";
  if (shot.footageId) return "green";
  return "animate";
};

/** Whole seconds a provider is asked for: enough to cover the shot, at least its minimum. */
export const requestSeconds = (kind: ClipKind, shotSec: number): number =>
  Math.max(kind === "talking" ? TALKING_MIN_SEC : ANIMATE_MIN_SEC, Math.ceil(shotSec + 0.25));

export const talkingPrompt = (shot: AdaptedScript["shots"][number], name: string): string =>
  `${name}, the woman in image 1, talks straight to the phone camera, saying exactly the words of audio 1 with precise lip-sync; audio 1 is her own voice. ` +
  `${shot.action} Same face, hair, outfit and room as image 1. Handheld phone camera, natural light, like a creator filming a selfie video. ` +
  "No other speech, no music, no captions or on-screen text.";

export const animatePrompt = (shot: AdaptedScript["shots"][number], kind: ClipKind): string =>
  [
    "Filmed on a phone, natural subtle handheld motion.",
    shot.action,
    kind === "green" ? "The laptop display stays a flat solid green the entire time; nothing appears on it." : "",
    "Keep every face, hand and object consistent. No captions or added text.",
  ]
    .filter(Boolean)
    .join(" ");

const ffmpeg = (args: string[]): void => {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
};

export const durationOf = (file: string): number =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());

/** Any generated clip → the output canvas (cover-cropped), constant frame rate, no audio. */
export const normalize = (input: string, output: string): void =>
  ffmpeg(["-i", input, "-an", "-vf", `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},fps=${FPS}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", output]);

/**
 * A screen recording framed for a vertical video: a crop around the clip's
 * focus scaled up to the full width, over a blurred, darkened fill of the
 * same footage. A recording shorter than the shot plays slower (at most
 * half speed), then holds its last frame.
 */
export const footageClip = (clip: ProductFootage["clips"][number], footagePath: string, shotSec: number, output: string): void => {
  const len = clip.endSec - clip.startSec;
  const slow = Math.min(2, Math.max(1, shotSec / len));
  const hold = Math.max(0, shotSec - len * slow) + 0.5;
  const focusX = clip.focusX ?? 0.5;
  const cropW = clip.cropWidth ?? 0.6;
  const fg = `crop=iw*${cropW}:ih:(iw-iw*${cropW})*${focusX}:0,scale=${WIDTH}:-2`;
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

/** Mono 16 kHz PCM of a file's audio, as numbers. */
const pcm = (file: string, fromSec = 0, toSec?: number): Float32Array => {
  const args = ["-v", "error", "-ss", String(fromSec), ...(toSec !== undefined ? ["-to", String(toSec)] : []), "-i", file, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"];
  const buf = execFileSync("ffmpeg", args, { maxBuffer: 1 << 28 });
  const ints = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  return Float32Array.from(ints, (v) => v / 32768);
};

/** 10 ms loudness envelope. */
const envelope = (x: Float32Array): number[] => {
  const out: number[] = [];
  for (let i = 0; i + 160 <= x.length; i += 160) {
    let s = 0;
    for (let j = i; j < i + 160; j++) s += x[j] * x[j];
    out.push(Math.sqrt(s / 160));
  }
  return out;
};

/**
 * How much later the speech in `clip` happens than in `reference` (seconds,
 * within ±1 s), from the best match of their loudness envelopes, and how
 * well they match (Pearson r). A lip-synced clip plays from this offset so
 * the mouth lands on our own voice track.
 */
export const speechOffset = (clip: string, reference: string): { offsetSec: number; match: number } => {
  const a = envelope(pcm(reference));
  const b = envelope(pcm(clip));
  let best = { lag: 0, r: -Infinity };
  for (let lag = -100; lag <= 100; lag++) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < a.length; i++) {
      const j = i + lag;
      if (j >= 0 && j < b.length) {
        xs.push(a[i]);
        ys.push(b[j]);
      }
    }
    if (xs.length < 50) continue;
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let k = 0; k < xs.length; k++) {
      num += (xs[k] - mx) * (ys[k] - my);
      dx += (xs[k] - mx) ** 2;
      dy += (ys[k] - my) ** 2;
    }
    const r = num / Math.sqrt(dx * dy || 1);
    if (r > best.r) best = { lag, r };
  }
  return { offsetSec: best.lag / 100, match: best.r };
};

/** The voice track's audio under one shot, as the WAV a lip-sync model takes. */
export const voiceSegment = (voiceTrack: string, fromSec: number, toSec: number, output: string): void =>
  ffmpeg(["-ss", fromSec.toFixed(3), "-to", toSec.toFixed(3), "-i", voiceTrack, "-ac", "1", "-ar", "44100", output]);

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

export const greenscreenScript = path.join(__dirname, "greenscreen.py");

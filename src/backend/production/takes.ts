import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { artifactsDir, repoRoot } from "../pipeline/paths";
import { stageAssets } from "../pipeline/render";
import { EdlSchema } from "../pipeline/schemas";
import type { Edl } from "../pipeline/types";
import { playRawClipAudio, swapShotClip } from "./edl";

/**
 * Every take of every shot of an AI video, so regenerating a shot never
 * throws the earlier takes away: the editor lists them per clip and puts
 * whichever one is chosen back on the timeline. Each take is its own file,
 * never overwritten. Kept beside job.json as jobs/<jobId>/takes.json (job
 * content, like project.json), written by `npm run produce` and read by
 * the editor's clip-takes route.
 */

export type Take = {
  id: string;
  /** public/-relative src, as the EDL references it. */
  src: string;
  /** Absolute path of the file, for staging. */
  file: string;
  durationSec: number;
  /** Where the shot starts in the take (a lip-synced take's speech offset). */
  inSec: number;
  rate?: number;
  createdAt: string;
  /** "retry": an attempt an automatic retry replaced (production/retry.ts). */
  origin: "original" | "regenerated" | "retry";
  /** The video-model prompt that made it, when it differs from the script's
   *  own (a change asked for in the shot chat); a later change builds on it. */
  prompt?: string;
  /** The still it was animated from, when that was an edited one (absolute path). */
  still?: string;
  /** What the user asked for, and the plan's short name for it (shot chat). */
  request?: string;
  label?: string;
};

export type ShotTakes = {
  /** False for a shot that is the product's own footage: a new take would be identical. */
  regenerable: boolean;
  /** Oldest first. */
  takes: Take[];
};

export type TakesFile = Record<string, ShotTakes>;

const takesPath = (jobId: string) => path.join(repoRoot, "jobs", jobId, "takes.json");
const edlPath = (jobId: string) => path.join(artifactsDir(jobId), "edl.json");

export const readTakes = (jobId: string): TakesFile => (fs.existsSync(takesPath(jobId)) ? (JSON.parse(fs.readFileSync(takesPath(jobId), "utf8")) as TakesFile) : {});

const writeTakes = (jobId: string, takes: TakesFile) => fs.writeFileSync(takesPath(jobId), JSON.stringify(takes, null, 2));

/** Records a take (once per file) and returns it with its id. */
export const addTake = (jobId: string, shotId: string, regenerable: boolean, take: Omit<Take, "id">): Take => {
  const all = readTakes(jobId);
  const shot = all[shotId] ?? { regenerable, takes: [] };
  shot.regenerable = regenerable;
  const existing = shot.takes.find((t) => t.src === take.src);
  if (existing) return existing;
  const added = { ...take, id: `${shotId}-t${shot.takes.length + 1}` };
  shot.takes.push(added);
  all[shotId] = shot;
  writeTakes(jobId, all);
  return added;
};

const readEdl = (jobId: string): Edl => EdlSchema.parse(JSON.parse(fs.readFileSync(edlPath(jobId), "utf8")));

/** A shot's raw generated clip, beside its takes (`<shot>.raw.mp4`): the model's own output, audio included. */
const rawClipOf = (shotId: string, take: Take): { src: string; file: string } => ({
  src: path.posix.join(path.posix.dirname(take.src), `${shotId}.raw.mp4`),
  file: path.join(path.dirname(take.file), `${shotId}.raw.mp4`),
});

const probe = (file: string, entries: string): string[] =>
  execFileSync("ffprobe", ["-v", "error", ...entries.split(" "), "-of", "csv=p=0", file]).toString().trim().split("\n");

/** The raw clip when it exists and has a voice in it (only the talking shots do). */
const rawClipWithAudio = (shotId: string, take: Take): (ReturnType<typeof rawClipOf> & { durationSec: number }) | null => {
  const raw = rawClipOf(shotId, take);
  if (!fs.existsSync(raw.file)) return null;
  try {
    if (!probe(raw.file, "-select_streams a -show_entries stream=codec_type")[0]) return null;
    return { ...raw, durationSec: Number(probe(raw.file, "-show_entries format=duration")[0]) };
  } catch {
    return null;
  }
};

/** The takes of the shot a timeline clip was cut from, and which is in use. `rawAudio`: the clip can
 *  play the raw clip's own audio (and is not already). */
export const takesForClip = (jobId: string, clipId: string): { shotId: string; currentTakeId: string | null; rawAudio: boolean } & ShotTakes => {
  const segment = readEdl(jobId).video.find((v) => v.id === clipId);
  if (!segment) throw new Error(`no clip ${clipId} on the timeline`);
  const shot = readTakes(jobId)[segment.blockId] ?? { regenerable: false, takes: [] };
  const rawAudio = shot.takes.length > 0 && !segment.src.endsWith(".raw.mp4") && rawClipWithAudio(segment.blockId, shot.takes[0]) !== null;
  return { shotId: segment.blockId, ...shot, currentTakeId: shot.takes.find((t) => t.src === segment.src)?.id ?? null, rawAudio };
};

/** Plays that clip's shot from its raw clip with the clip's own audio, replacing the ElevenLabs lines under it. */
export const chooseRawAudio = (jobId: string, clipId: string): Edl => {
  const edl = readEdl(jobId);
  const segment = edl.video.find((v) => v.id === clipId);
  if (!segment) throw new Error(`no clip ${clipId} on the timeline`);
  const takes = readTakes(jobId)[segment.blockId]?.takes ?? [];
  const current = takes.find((t) => t.src === segment.src) ?? takes[takes.length - 1];
  const raw = current && rawClipWithAudio(segment.blockId, current);
  if (!current || !raw) throw new Error(`shot ${segment.blockId} has no raw clip with audio`);
  const swapped = EdlSchema.parse(playRawClipAudio(edl, segment.blockId, { ...raw, inSec: current.inSec }));
  fs.writeFileSync(edlPath(jobId), JSON.stringify(swapped, null, 2));
  stageAssets(swapped);
  return swapped;
};

/** Puts a take of that clip's shot on the timeline, keeping every other edit. */
export const chooseTake = (jobId: string, clipId: string, takeId: string): Edl => {
  const edl = readEdl(jobId);
  const segment = edl.video.find((v) => v.id === clipId);
  if (!segment) throw new Error(`no clip ${clipId} on the timeline`);
  const take = readTakes(jobId)[segment.blockId]?.takes.find((t) => t.id === takeId);
  if (!take) throw new Error(`no take ${takeId} of shot ${segment.blockId}`);
  if (!fs.existsSync(take.file)) throw new Error(`the file for ${takeId} is missing`);
  const swapped = EdlSchema.parse(swapShotClip(edl, segment.blockId, take));
  fs.writeFileSync(edlPath(jobId), JSON.stringify(swapped, null, 2));
  stageAssets(swapped);
  return swapped;
};

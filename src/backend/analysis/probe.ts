import { execFileSync } from "node:child_process";

/** What ffprobe says about a file — the dimensions the rest of the analyzer
 *  is sized against. */
export type MediaInfo = {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
};

type ProbeStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  duration?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
};

const parseFraction = (s: string | undefined): number => {
  if (!s) return 0;
  const [n, d] = s.split("/").map(Number);
  return d ? n / d : n || 0;
};

/** Throws on a file with no video stream or no measurable duration — the
 *  analyzer has nothing to say about either. */
export const probeMedia = (filePath: string): MediaInfo => {
  const raw = execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
  });
  const parsed = JSON.parse(raw) as { streams?: ProbeStream[]; format?: { duration?: string } };
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  if (!video || !video.width || !video.height) throw new Error(`probe: no video stream in ${filePath}`);

  // A phone clip is often stored landscape with a rotation flag that
  // players (and ffmpeg's decoder) apply. Report the DISPLAYED size.
  const rotation = Math.abs(video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? Number(video.tags?.rotate ?? 0));
  const swapped = rotation === 90 || rotation === 270;

  const durationSec = Number(parsed.format?.duration ?? video.duration ?? 0);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error(`probe: could not read a duration from ${filePath}`);

  return {
    durationSec,
    width: swapped ? video.height : video.width,
    height: swapped ? video.width : video.height,
    fps: parseFraction(video.avg_frame_rate) || 30,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
};

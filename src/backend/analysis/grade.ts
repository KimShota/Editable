import { execFileSync } from "node:child_process";
import type { VideoAnalysis } from "./schemas";

/**
 * The picture's overall look: tonal range, saturation and color balance,
 * measured over ~24 frames spread across the video.
 *
 * These are ABSOLUTE statistics of the finished picture, not a GradeSchema
 * (which is a set of adjustments layered ON a picture). Turning one into
 * the other needs a neutral reference, which the style engine supplies —
 * this module only reports what is on screen.
 */

const W = 96;
const H = 170;
const FRAME_BYTES = W * H * 3;
const SAMPLE_FRAMES = 24;

export type GradeMeasurements = VideoAnalysis["grade"];

export const measureGrade = (filePath: string, durationSec: number): GradeMeasurements => {
  // Spread SAMPLE_FRAMES evenly: fps = frames / duration, capped by -frames:v.
  const fps = Math.max(0.05, SAMPLE_FRAMES / durationSec);
  const raw = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", filePath, "-an", "-vf", `fps=${fps},scale=${W}:${H}:flags=area,format=rgb24`, "-frames:v", String(SAMPLE_FRAMES), "-f", "rawvideo", "-"],
    { maxBuffer: FRAME_BYTES * (SAMPLE_FRAMES + 8) },
  );
  const pixels = Math.floor(raw.length / 3);
  if (pixels === 0) throw new Error(`grade: decoded no frames from ${filePath}`);

  const hist = new Array<number>(256).fill(0);
  let sumR = 0;
  let sumB = 0;
  let sumLuma = 0;
  let sumSat = 0;
  for (let i = 0; i < pixels; i++) {
    const r = raw[i * 3];
    const g = raw[i * 3 + 1];
    const b = raw[i * 3 + 2];
    const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    hist[luma]++;
    sumLuma += luma;
    sumR += r;
    sumB += b;
    const max = Math.max(r, g, b);
    sumSat += max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
  }
  const pct = (p: number): number => {
    const target = (pixels * p) / 100;
    let c = 0;
    for (let v = 0; v < 256; v++) {
      c += hist[v];
      if (c >= target) return v / 255;
    }
    return 1;
  };
  const round3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    lumaMean: round3(sumLuma / pixels / 255),
    lumaP5: round3(pct(5)),
    lumaP50: round3(pct(50)),
    lumaP95: round3(pct(95)),
    satMean: round3(sumSat / pixels),
    warmth: round3((sumR - sumB) / pixels / 255),
  };
};

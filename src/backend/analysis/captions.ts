import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractFrame } from "../pipeline/shotDetect";
import type { VideoAnalysis } from "./schemas";

/**
 * On-screen text (captions) by OCR on frames sampled across the video.
 *
 * Optional by design: tesseract is a system binary that may not be on every
 * box. When it's absent, `measured` is false and every other field is null —
 * "we didn't look", never "there are no captions".
 *
 * The caption MODE is a heuristic read of how much of the video carries text
 * and how many words at a time — it can't see word-by-word timing at ~1 fps
 * sampling, so it separates "text nearly always on screen, a few words"
 * (karaoke-style) from "full sentences" from "text now and then" (keyword),
 * and no more. The optional semantic pass can refine it.
 */

export type CaptionMeasurements = VideoAnalysis["captions"];

const FRAMES = 12;
const FRAME_WIDTH = 540;
const MIN_WORD_CONF = 60;
const MIN_WORDS_PER_FRAME = 2;
const OCR_TIMEOUT_MS = 20_000;

/** coverage below this: no captions to speak of. */
const NONE_COVERAGE = 0.15;
/** coverage at/above this: text is a constant presence. */
const ALWAYS_ON_COVERAGE = 0.5;
/** Constant text of at most this many words at a time reads as karaoke. */
const KARAOKE_MAX_WORDS = 4;

const UNMEASURED: CaptionMeasurements = { measured: false, coverage: null, medianWords: null, position: null, mode: null };

export const tesseractAvailable = (): boolean => {
  const r = spawnSync("tesseract", ["--version"], { stdio: "ignore" });
  return r.status === 0;
};

type OcrWord = { text: string; centerY: number };

/** Words tesseract is confident about, with their vertical position (0-1).
 *  TSV columns: level page block par line word left top width height conf text. */
const parseTsv = (tsv: string, frameHeight: number): OcrWord[] => {
  const words: OcrWord[] = [];
  for (const line of tsv.split("\n").slice(1)) {
    const cols = line.split("\t");
    if (cols.length < 12 || cols[0] !== "5") continue;
    const text = cols[11].trim();
    const conf = Number(cols[10]);
    if (text.length < 2 || conf < MIN_WORD_CONF) continue;
    // A caption is letters; OCR noise on a busy picture is mostly symbols.
    if ((text.match(/[\p{L}\p{N}]/gu) ?? []).length / text.length < 0.6) continue;
    words.push({ text, centerY: (Number(cols[7]) + Number(cols[9]) / 2) / frameHeight });
  }
  return words;
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export const classifyCaptions = (perFrame: OcrWord[][]): CaptionMeasurements => {
  const withText = perFrame.filter((w) => w.length >= MIN_WORDS_PER_FRAME);
  const coverage = perFrame.length ? withText.length / perFrame.length : 0;
  if (withText.length === 0 || coverage < NONE_COVERAGE) {
    return { measured: true, coverage: Math.round(coverage * 100) / 100, medianWords: null, position: null, mode: "none" };
  }
  const medianWords = median(withText.map((w) => w.length));
  const y = median(withText.flat().map((w) => w.centerY));
  const position = y < 1 / 3 ? "top" : y < 2 / 3 ? "middle" : "bottom";
  const mode =
    coverage >= ALWAYS_ON_COVERAGE ? (medianWords <= KARAOKE_MAX_WORDS ? "karaoke" : "full") : "keyword";
  return { measured: true, coverage: Math.round(coverage * 100) / 100, medianWords, position, mode };
};

/** Returns `measured: false` when tesseract isn't installed. A failure on
 *  one frame costs that frame, not the measurement. */
export const measureCaptions = (filePath: string, durationSec: number): CaptionMeasurements => {
  if (!tesseractAvailable()) return UNMEASURED;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-ocr-"));
  try {
    const perFrame: OcrWord[][] = [];
    for (let i = 0; i < FRAMES; i++) {
      const at = ((i + 0.5) / FRAMES) * durationSec;
      const img = path.join(workDir, `f${i}.jpg`);
      if (!extractFrame(filePath, at, img, FRAME_WIDTH)) continue;
      try {
        const tsv = execFileSync("tesseract", [img, "stdout", "--psm", "11", "tsv"], {
          encoding: "utf8",
          timeout: OCR_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 1024 * 1024 * 8,
        });
        // Frame height from the level-1 (page) row: the TSV carries it.
        const pageRow = tsv.split("\n")[1]?.split("\t");
        const frameHeight = Number(pageRow?.[9]) || FRAME_WIDTH * (16 / 9);
        perFrame.push(parseTsv(tsv, frameHeight));
      } catch {
        // skip this frame
      }
    }
    if (perFrame.length === 0) return UNMEASURED;
    return classifyCaptions(perFrame);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FilledFormat, Format, Transcript, Word } from "./types";
import { modelsDir } from "./paths";

/**
 * Module 3 — Transcription.
 * For each voice block, runs whisper.cpp to produce word-level timestamps.
 * Silent b-roll blocks are skipped. Word times are seconds relative to the
 * RAW clip (trimming happens downstream, against these times).
 */

const MODEL_FILE = path.join(modelsDir, "ggml-base.en.bin");

type WhisperJson = {
  transcription?: Array<{
    text: string;
    offsets: { from: number; to: number };
  }>;
};

const transcribeClip = (clipAbsPath: string, workDir: string): Word[] => {
  const wav = path.join(workDir, `${path.basename(clipAbsPath)}.wav`);
  // Whisper wants 16 kHz mono PCM.
  execFileSync(
    "ffmpeg",
    ["-y", "-v", "error", "-i", clipAbsPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],
    { stdio: ["ignore", "ignore", "inherit"] },
  );

  const outPrefix = path.join(workDir, path.basename(clipAbsPath));
  // -ml 1 -sow: one word per segment, split on word boundaries.
  execFileSync(
    "whisper-cli",
    ["-m", MODEL_FILE, "-f", wav, "-oj", "-ml", "1", "-sow", "-of", outPrefix],
    { stdio: "ignore" },
  );

  const json = JSON.parse(
    fs.readFileSync(`${outPrefix}.json`, "utf8"),
  ) as WhisperJson;

  const words: Word[] = [];
  for (const seg of json.transcription ?? []) {
    const text = seg.text.trim();
    if (text.length === 0) continue;
    words.push({
      text,
      startSec: seg.offsets.from / 1000,
      endSec: seg.offsets.to / 1000,
    });
  }
  return words;
};

export const transcribe = (format: Format, filled: FilledFormat): Transcript => {
  if (!fs.existsSync(MODEL_FILE)) {
    throw new Error(
      `Whisper model not found at ${MODEL_FILE}. Download it with:\n` +
        `  curl -L -o models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`,
    );
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-whisper-"));
  try {
    const blocks = [];
    for (const block of format.blocks) {
      if (block.kind !== "voice") continue;
      const clip = filled.bindings[block.videoSlot];
      if (clip?.type !== "file") {
        throw new Error(`transcribe: block "${block.id}" has no bound clip`);
      }
      const words = transcribeClip(clip.absPath, workDir);
      if (words.length === 0) {
        console.warn(
          `transcribe: no speech detected in voice block "${block.id}" (${clip.path})`,
        );
      }
      blocks.push({ blockId: block.id, words });
    }
    return { blocks };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

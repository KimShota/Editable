import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Word } from "./types";
import { modelsDir } from "./paths";

/**
 * Whisper.cpp transcription for a single media file — factored out of
 * transcribe.ts (Module 3) so it's callable standalone by anything that
 * needs word-level timestamps for one file without the rest of the
 * per-block/per-take machinery (e.g. the format-authoring pipeline's
 * analyze step, transcribing a single reference clip).
 */

export const MODEL_FILE = path.join(modelsDir, "ggml-base.en.bin");

type WhisperJson = {
  transcription?: Array<{
    text: string;
    offsets: { from: number; to: number };
  }>;
};

export const requireWhisperModel = (): void => {
  if (!fs.existsSync(MODEL_FILE)) {
    throw new Error(
      `Whisper model not found at ${MODEL_FILE}. Download it with:\n` +
        `  curl -L -o models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`,
    );
  }
};

/** Transcribes one media file to word-level timestamps, seconds relative to
 *  that file's own start. `workDir` holds the intermediate wav/json. */
export const transcribeFile = (clipAbsPath: string, workDir: string): Word[] => {
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

  const json = JSON.parse(fs.readFileSync(`${outPrefix}.json`, "utf8")) as WhisperJson;

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

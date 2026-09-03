import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Word } from "./types";
import { modelsDir } from "./paths";
import { containsCjk } from "../components/cjk";

/**
 * Whisper.cpp transcription for a single media file — factored out of
 * transcribe.ts (Module 3) so it's callable standalone by anything that
 * needs word-level timestamps for one file without the rest of the
 * per-block/per-take machinery (e.g. the format-authoring pipeline's
 * analyze step, transcribing a single reference clip).
 */

/** Multilingual (not the `.en`-suffixed English-only variant) so the same
 *  model handles English and Japanese content — see requireWhisperModel's
 *  download instructions. "medium" chosen over base/small for the best
 *  accuracy on both languages; Japanese in particular (dense kanji, no
 *  word spacing) needs more capacity than the smaller models give it. */
export const MODEL_FILE = path.join(modelsDir, "ggml-medium.bin");

type WhisperSegment = { text: string; offsets: { from: number; to: number } };
type WhisperJson = {
  transcription?: WhisperSegment[];
};

export const requireWhisperModel = (): void => {
  if (!fs.existsSync(MODEL_FILE)) {
    throw new Error(
      `Whisper model not found at ${MODEL_FILE}. Download it with:\n` +
        `  curl -L -o models/ggml-medium.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin`,
    );
  }
};

/**
 * Reconstructs real "words" from whisper's own raw per-TOKEN segments
 * (`-ml 1` alone, deliberately WITHOUT `-sow` — see this function's own
 * call site). A token whose text contains a CJK character is already a
 * complete, correctly-sized unit on its own — Japanese/Chinese has no
 * word-internal fragments the way BPE splits an unfamiliar Latin word —
 * so it's kept as its own word, never merged with a neighbor. Everything
 * else is Latin-script BPE: whisper marks a token that STARTS a new word
 * with a leading space; a token with none is a continuation fragment of
 * the previous word (e.g. "Cla" + "ude" + "." for a name whisper doesn't
 * know as one piece) and gets glued onto it.
 *
 * This exists because `-sow` ("split on word") is a Latin-only heuristic
 * with no real word-boundary signal to work from in a language that has
 * no spaces at all — tested directly against this model: with `-sow` on,
 * a whole spoken Japanese CLAUSE comes back as one "word" (no per-word
 * captions, no usable timing for script/transcript alignment); dropping
 * it and doing the merge ourselves, informed by each token's own content
 * rather than a blanket per-language mode, gives Japanese real per-
 * character/short-cluster segments while still reconstructing whole
 * English words exactly as `-sow` would have (verified against its
 * output directly) — and handles code-switched audio correctly too,
 * since the decision is made per token, not once for the whole file.
 */
const mergeTokensIntoWords = (segments: WhisperSegment[]): Word[] => {
  const words: Word[] = [];
  let current: { text: string; startSec: number; endSec: number } | null = null;
  for (const seg of segments) {
    const stripped = seg.text.trim();
    if (stripped.length === 0) continue;
    const startSec = seg.offsets.from / 1000;
    const endSec = seg.offsets.to / 1000;
    const isCjkToken = containsCjk(stripped);
    if (current === null || isCjkToken || seg.text.startsWith(" ") || containsCjk(current.text)) {
      words.push(...(current ? [current] : []));
      current = { text: stripped, startSec, endSec };
    } else {
      current.text += stripped;
      current.endSec = endSec;
    }
  }
  if (current) words.push(current);
  return words;
};

/** Transcribes one media file to word-level timestamps, seconds relative to
 *  that file's own start. `workDir` holds the intermediate wav/json.
 *  `language` is a whisper.cpp language code (e.g. "en", "ja") or "auto"
 *  for per-file automatic language detection — see JobManifestSchema's own
 *  `language` field, the source of this value for every real caller. */
export const transcribeFile = (clipAbsPath: string, workDir: string, language: string = "auto"): Word[] => {
  const wav = path.join(workDir, `${path.basename(clipAbsPath)}.wav`);
  // Whisper wants 16 kHz mono PCM.
  execFileSync(
    "ffmpeg",
    ["-y", "-v", "error", "-i", clipAbsPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],
    { stdio: ["ignore", "ignore", "inherit"] },
  );

  const outPrefix = path.join(workDir, path.basename(clipAbsPath));
  // -ml 1: one TOKEN per segment (not `-sow`'s "one word" — see
  // mergeTokensIntoWords for why that heuristic doesn't work for Japanese).
  execFileSync(
    "whisper-cli",
    ["-m", MODEL_FILE, "-f", wav, "-oj", "-ml", "1", "-l", language, "-of", outPrefix],
    { stdio: "ignore" },
  );

  const json = JSON.parse(fs.readFileSync(`${outPrefix}.json`, "utf8")) as WhisperJson;
  return mergeTokensIntoWords(json.transcription ?? []);
};

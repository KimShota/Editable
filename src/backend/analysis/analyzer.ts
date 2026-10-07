import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODEL_FILE, transcribeFile } from "../pipeline/whisper";
import type { Word } from "../pipeline/types";
import { decodePcm, dropNonSpeechTags, measureAudio, speechIntervalsFromWords } from "./audio";
import { measureCaptions } from "./captions";
import { computeStyleFeatures } from "./features";
import { measureGrade } from "./grade";
import { probeMedia } from "./probe";
import { type StyleFeatures, type VideoAnalysis, VideoAnalysisSchema } from "./schemas";
import type { SemanticProvider } from "./semantic";
import { ANALYZER_VERSION } from "./version";
import { SETUP_HINT, separateVocals, vocalsInstalled } from "./vocals";
import { measureVisual } from "./visual";

/**
 * Module A — Ingest & Analyze (creator-brand-memory plan, section 3A).
 *
 * One entry point that turns a video file into the canonical VideoAnalysis
 * plus its StyleFeatures. It is the same call whether the video is a
 * creator's published reel or the pipeline's own render.
 *
 * Nothing here is required to succeed except the picture: a missing whisper
 * model, missing tesseract, an absent audio track or an unconfigured API key
 * each leave their fields null and add a line to `warnings`, so one
 * unavailable dependency never blocks the whole analysis.
 */

export type AnalyzeOptions = {
  /** sha256 of the file, if the caller already has it (it becomes part of
   *  the stored cache key). */
  contentHash?: string | null;
  /** "auto": transcribe if the whisper model is installed. false: skip. */
  transcript?: "auto" | boolean;
  /** Take the music out before transcribing (Demucs), so music is not heard as speech.
   *  "auto": do it if Demucs is installed. true: same, but warn loudly if it is missing. false: transcribe the full mix. */
  vocals?: "auto" | boolean;
  /** "auto": run OCR if tesseract is installed. false: skip. */
  captions?: "auto" | boolean;
  /** Omit to skip the semantic pass (it costs an API call). */
  semantic?: SemanticProvider;
  /** Refuse anything longer than this — analysis holds frames in memory and
   *  is meant for short-form. Default 900 (15 minutes). */
  maxDurationSec?: number;
};

export type AnalysisResult = { analysis: VideoAnalysis; features: StyleFeatures };

const DEFAULT_MAX_DURATION_SEC = 900;

const wordsPerMin = (words: Word[], speechSec: number): number | null =>
  words.length > 0 && speechSec > 1 ? Math.round((words.length / speechSec) * 60) : null;

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const analyzeVideoFile = async (filePath: string, opts: AnalyzeOptions = {}): Promise<AnalysisResult> => {
  if (!fs.existsSync(filePath)) throw new Error(`analyze: no such file ${filePath}`);
  const warnings: string[] = [];

  const media = probeMedia(filePath);
  const maxDuration = opts.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC;
  if (media.durationSec > maxDuration) {
    throw new Error(`analyze: ${media.durationSec.toFixed(0)}s is over the ${maxDuration}s limit`);
  }

  const visual = measureVisual(filePath, media.durationSec);
  const grade = measureGrade(filePath, media.durationSec);

  // Transcript first: the speech intervals it gives are what lets the audio
  // pass separate speech from a music bed and SFX.
  let transcript: VideoAnalysis["transcript"] = null;
  const wantTranscript = opts.transcript ?? "auto";
  if (wantTranscript !== false && media.hasAudio) {
    if (fs.existsSync(MODEL_FILE)) {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-analysis-"));
      try {
        // The vocals alone, when Demucs can give them: otherwise the full mix, music included.
        let from = filePath;
        let vocalsSeparated = false;
        if (opts.vocals !== false) {
          if (vocalsInstalled()) {
            try {
              from = separateVocals(filePath, workDir);
              vocalsSeparated = true;
            } catch (e) {
              warnings.push(`vocal separation failed, transcribed the full mix instead: ${errMessage(e)}`);
            }
          } else {
            warnings.push(`vocal separation (Demucs) is not installed, so music can be heard as speech: ${SETUP_HINT}`);
          }
        }
        const words = dropNonSpeechTags(transcribeFile(from, workDir));
        const speechSec = speechIntervalsFromWords(words).reduce((s, [a, b]) => s + (b - a), 0);
        transcript = { words, wordsPerMin: wordsPerMin(words, speechSec), vocalsSeparated };
      } catch (e) {
        warnings.push(`transcript failed: ${errMessage(e)}`);
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    } else if (wantTranscript === true) {
      warnings.push("transcript requested but the whisper model is not installed");
    } else {
      warnings.push("no whisper model installed — transcript, speech ratio and SFX onsets are unknown");
    }
  }

  const pcm = media.hasAudio ? decodePcm(filePath) : null;
  if (!media.hasAudio) warnings.push("no audio track");
  const audio = measureAudio(pcm, media.durationSec, transcript ? speechIntervalsFromWords(transcript.words) : null);

  const wantCaptions = opts.captions ?? "auto";
  const captions: VideoAnalysis["captions"] =
    wantCaptions === false
      ? { measured: false, coverage: null, medianWords: null, position: null, mode: null }
      : measureCaptions(filePath, media.durationSec);
  if (wantCaptions !== false && !captions.measured) warnings.push("tesseract unavailable — caption fields are unknown");

  let semantic: VideoAnalysis["semantic"] = null;
  if (opts.semantic) {
    try {
      semantic = await opts.semantic.describe({
        filePath,
        durationSec: media.durationSec,
        transcriptExcerpt: transcript ? transcript.words.map((w) => w.text).join(" ") : null,
      });
    } catch (e) {
      warnings.push(`semantic pass failed: ${errMessage(e)}`);
    }
  }

  // Parse rather than cast: the analysis is a stored contract, so a field
  // that drifts out of shape fails HERE, at the source, not in a reader.
  const analysis = VideoAnalysisSchema.parse({
    analyzerVersion: ANALYZER_VERSION,
    contentHash: opts.contentHash ?? null,
    media,
    ...visual,
    audio,
    transcript,
    captions,
    grade,
    semantic,
    warnings,
  } satisfies VideoAnalysis);

  return { analysis, features: computeStyleFeatures(analysis) };
};

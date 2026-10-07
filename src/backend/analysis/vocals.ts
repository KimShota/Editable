import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The vocals of a video's audio, with the music taken out (Demucs, run locally:
 * free, no network once its model is downloaded). The analyzer transcribes THIS
 * instead of the full mix, so a music-only reel reads as "no speech" rather than
 * whisper hearing words in the song, and a quiet voice under music is still heard.
 *
 * What it can't do: sung lyrics are vocals too, so they stay in the stem. Telling
 * lyrics from someone speaking is the spec step's job (each line's `delivery`).
 *
 * Demucs needs PyTorch, so it lives in its own Python environment outside the
 * repo (`npm run setup:vocals`), found by DEMUCS_BIN. Without it the analyzer
 * falls back to the full mix and says so in its warnings.
 */

export const DEMUCS_BIN = process.env.DEMUCS_BIN ?? path.join(os.homedir(), ".cache", "editable", "demucs-venv", "bin", "demucs");
export const SETUP_HINT = "run `npm run setup:vocals`";

/** `cpu` by default: it is fast enough for short-form (about the clip's own length) and always works. */
const DEVICE = process.env.DEMUCS_DEVICE ?? "cpu";
const TIMEOUT_MS = 10 * 60_000;

export const vocalsInstalled = (): boolean => fs.existsSync(DEMUCS_BIN);

/** A 44.1 kHz stereo vocals-only wav of `mediaPath`'s audio, written under `workDir`. Throws if Demucs fails. */
export const separateVocals = (mediaPath: string, workDir: string): string => {
  const mix = path.join(workDir, "mix.wav");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", mediaPath, "-vn", "-ac", "2", "-ar", "44100", mix], { stdio: ["ignore", "ignore", "inherit"] });
  const out = path.join(workDir, "demucs");
  try {
    execFileSync(DEMUCS_BIN, ["--two-stems=vocals", "-n", "htdemucs", "-d", DEVICE, "-o", out, mix], { stdio: ["ignore", "ignore", "pipe"], timeout: TIMEOUT_MS });
  } catch (e) {
    // Demucs prints a progress bar to stderr: keep only the end, where the error is.
    const stderr = (e as { stderr?: Buffer }).stderr?.toString().trim().split(/\r|\n/).filter(Boolean).slice(-3).join(" | ");
    throw new Error(stderr || (e instanceof Error ? e.message : String(e)));
  }
  const vocals = path.join(out, "htdemucs", "mix", "vocals.wav");
  if (!fs.existsSync(vocals)) throw new Error("demucs ran but wrote no vocals file");
  return vocals;
};

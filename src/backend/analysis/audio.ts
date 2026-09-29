import { execFileSync } from "node:child_process";
import type { VideoAnalysis } from "./schemas";

/**
 * Everything the analyzer measures from SOUND alone: a loudness curve, the
 * speech / audible-bed split, a beat grid, and strong non-speech onsets
 * (the SFX-and-hit candidates).
 *
 * One ffmpeg pass decodes mono 16 kHz PCM and the rest is DSP in memory.
 * No FFT and no dependency: loudness and onsets are energy measures, and
 * the beat tracker autocorrelates the onset track — coarse next to a
 * dedicated MIR library, but enough to answer the question the style
 * engine asks ("is there a steady beat, and at what tempo").
 */

const SAMPLE_RATE = 16000;
/** Onset / beat analysis frame: 256 samples = 16 ms (62.5 Hz). */
const HOP = 256;
const ENV_HZ = SAMPLE_RATE / HOP;
/** Loudness curve resolution: 10 Hz. */
const LOUDNESS_HZ = 10;
const LOUDNESS_WINDOW = SAMPLE_RATE / LOUDNESS_HZ;

/** Below this a window is silence, not signal. */
const SILENCE_DB = -70;
/** Above this a non-speech window counts as an audible bed (music/ambience). */
const BED_DB = -40;

/** An onset is "strong" (SFX candidate) if the level jumps at least this
 *  much in one hop and lands above a floor. */
const SFX_JUMP_DB = 12;
const SFX_FLOOR_DB = -40;
/** Two onsets closer than this are one sound. */
const ONSET_MERGE_SEC = 0.12;
const MAX_SFX_ONSETS = 300;

const MIN_BPM = 60;
const MAX_BPM = 180;
/** Fewer onsets than this can't establish a tempo. */
const MIN_ONSETS_FOR_BEAT = 6;
const MIN_SECONDS_FOR_BEAT = 4;
/** Autocorrelation peaks within this share of the strongest count as
 *  equally strong — then the SHORTEST period wins, so 120 BPM is not
 *  reported as 60 just because every second click is also periodic. */
const TEMPO_TIE = 0.9;
/** Below this the onset track isn't periodic enough to call a beat.
 *  PROVISIONAL, from synthetic data only: random sparse onsets score
 *  0.10-0.16 and click tracks 0.74-0.89, so 0.25 sits clear of the noise
 *  floor. Real music is untested — re-fit on the labeled reel set (plan
 *  section 9) and bump ANALYZER_VERSION if it moves. */
const MIN_BEAT_CONFIDENCE = 0.25;

export type AudioMeasurements = VideoAnalysis["audio"];

const db = (power: number): number => 10 * Math.log10(power + 1e-12);

export const decodePcm = (filePath: string): Int16Array => {
  const raw = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", filePath, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"],
    { maxBuffer: 1024 * 1024 * 512 },
  );
  // Copy into an aligned buffer: a Node Buffer's byteOffset need not be even.
  const aligned = new Uint8Array(raw.length - (raw.length % 2));
  aligned.set(raw.subarray(0, aligned.length));
  return new Int16Array(aligned.buffer);
};

/** Per-hop level in dBFS (0 = full-scale sine power reference). */
const hopLevelsDb = (pcm: Int16Array): number[] => {
  const n = Math.floor(pcm.length / HOP);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = i * HOP; j < (i + 1) * HOP; j++) sum += pcm[j] * pcm[j];
    out[i] = db(sum / HOP / (32768 * 32768));
  }
  return out;
};

const loudnessCurve = (pcm: Int16Array): number[] => {
  const n = Math.floor(pcm.length / LOUDNESS_WINDOW);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = i * LOUDNESS_WINDOW; j < (i + 1) * LOUDNESS_WINDOW; j++) sum += pcm[j] * pcm[j];
    out[i] = Math.round(db(sum / LOUDNESS_WINDOW / (32768 * 32768)) * 10) / 10;
  }
  return out;
};

const percentile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * q))];
};

/** Merges [start, end] intervals that are closer than `gapSec`. */
const mergeIntervals = (intervals: Array<[number, number]>, gapSec: number): Array<[number, number]> => {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s - last[1] <= gapSec) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
};

const inAny = (t: number, intervals: Array<[number, number]>): boolean => intervals.some(([s, e]) => t >= s && t <= e);

/** Onset strength: the half-wave-rectified rise in level between hops. */
const onsetEnvelope = (levels: number[]): number[] =>
  // The previous level is floored at SILENCE_DB so a click out of digital
  // silence (-120 dB) reads as a ~50 dB onset, not a 100 dB outlier that
  // would dominate every autocorrelation.
  levels.map((l, i) => (i === 0 ? 0 : Math.max(0, l - Math.max(levels[i - 1], SILENCE_DB))));

/**
 * Tempo by autocorrelation of the onset envelope over the 60-180 BPM lags,
 * then a beat grid by picking the phase that lands on the most onset energy.
 */
export const trackBeat = (env: number[], durationSec: number): AudioMeasurements["beat"] => {
  const none = { bpm: null, confidence: 0, beatTimesSec: [] as number[] };
  const strong = env.filter((e) => e > 6).length;
  if (durationSec < MIN_SECONDS_FOR_BEAT || strong < MIN_ONSETS_FOR_BEAT) return none;

  const minLag = Math.floor((ENV_HZ * 60) / MAX_BPM);
  const maxLag = Math.ceil((ENV_HZ * 60) / MIN_BPM);
  const n = env.length;
  if (n <= maxLag * 2) return none;

  const ac = (lag: number): number => {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += env[i] * env[i + lag];
    return sum / (n - lag);
  };
  const zero = ac(0);
  if (zero <= 0) return none;

  const scores: number[] = [];
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) scores[lag] = lag < 1 ? 0 : ac(lag);
  // Local maxima inside the tempo range.
  const peaks: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (scores[lag] >= scores[lag - 1] && scores[lag] >= scores[lag + 1] && scores[lag] > 0) peaks.push(lag);
  }
  if (peaks.length === 0) return none;
  const top = Math.max(...peaks.map((l) => scores[l]));
  const lag = peaks.filter((l) => scores[l] >= top * TEMPO_TIE).sort((a, b) => a - b)[0];
  const confidence = Math.min(1, scores[lag] / zero);
  if (confidence < MIN_BEAT_CONFIDENCE) return { ...none, confidence };

  // Parabolic interpolation around the peak for sub-hop period accuracy.
  const y0 = scores[lag - 1];
  const y1 = scores[lag];
  const y2 = scores[lag + 1];
  const denom = y0 - 2 * y1 + y2;
  const refined = denom !== 0 ? lag + (0.5 * (y0 - y2)) / denom : lag;
  const period = refined; // in env frames
  const bpm = (ENV_HZ * 60) / period;

  // Phase: the grid offset that collects the most onset energy.
  let bestPhase = 0;
  let bestEnergy = -1;
  for (let phase = 0; phase < period; phase += 1) {
    let e = 0;
    for (let t = phase; t < n; t += period) e += env[Math.round(t)] ?? 0;
    if (e > bestEnergy) {
      bestEnergy = e;
      bestPhase = phase;
    }
  }
  const beats: number[] = [];
  for (let t = bestPhase; t < n; t += period) beats.push(Math.round((t / ENV_HZ) * 1000) / 1000);
  return { bpm: Math.round(bpm * 10) / 10, confidence: Math.round(confidence * 1000) / 1000, beatTimesSec: beats };
};

export type SpeechIntervals = Array<[number, number]>;

/** A tag can run long: whisper repeats a sound it can't transcribe inside ONE
 *  bracket ("[Beep, beep, beep, … beep]"), ten tokens for a 12 s click track
 *  and far more for a long music bed. */
const MAX_TAG_TOKENS = 64;

/**
 * Whisper narrates sound it can't transcribe — "[Music]", "[Beep, beep]",
 * "(applause)", "♪" — as if it were words. Left in, a music-only video reads
 * as 90% speech, which zeroes the music ratio and hides every SFX onset.
 * Drops those tagged spans and music-note tokens.
 *
 * The cost: genuine speech that whisper itself put in brackets is dropped
 * too. Whisper does not do that for real speech, so this is the right trade.
 * An opener with no closer within MAX_TAG_TOKENS is treated as ordinary text.
 */
export const dropNonSpeechTags = <T extends { text: string }>(words: T[]): T[] => {
  const opens = (t: string) => /^[[(]/.test(t);
  const closes = (t: string) => /[\])][.,!?]*$/.test(t);
  const out: T[] = [];
  for (let i = 0; i < words.length; i++) {
    const t = words[i].text.trim();
    if (t.includes("♪")) continue;
    if (opens(t)) {
      let end = closes(t) ? i : -1;
      for (let j = i + 1; end === -1 && j < Math.min(words.length, i + MAX_TAG_TOKENS); j++) {
        if (closes(words[j].text.trim())) end = j;
      }
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    out.push(words[i]);
  }
  return out;
};

/** Speech intervals from word timestamps: words closer than `gapSec` are one
 *  utterance, so the pauses between words don't count as "not speech". */
export const speechIntervalsFromWords = (words: Array<{ startSec: number; endSec: number }>, gapSec = 0.35): SpeechIntervals =>
  mergeIntervals(
    words.map((w) => [w.startSec, w.endSec] as [number, number]),
    gapSec,
  );

/**
 * `speech` is null when there is no transcript — then the speech/music split
 * and the SFX onsets are unknowable (a consonant would read as an "SFX"), so
 * they are left null/empty rather than guessed.
 */
export const measureAudio = (pcm: Int16Array | null, durationSec: number, speech: SpeechIntervals | null): AudioMeasurements => {
  if (!pcm || pcm.length < LOUDNESS_WINDOW) {
    return {
      present: false,
      loudnessHz: LOUDNESS_HZ,
      loudnessDb: [],
      loudnessMeanDb: null,
      loudnessRangeDb: null,
      speechRatio: null,
      musicRatio: null,
      beat: { bpm: null, confidence: 0, beatTimesSec: [] },
      sfxOnsetsSec: [],
    };
  }

  const curve = loudnessCurve(pcm);
  const audible = curve.filter((v) => v > SILENCE_DB);
  const loudnessMeanDb = audible.length ? Math.round((audible.reduce((a, b) => a + b, 0) / audible.length) * 10) / 10 : null;
  const loudnessRangeDb = audible.length ? Math.round((percentile(audible, 0.9) - percentile(audible, 0.1)) * 10) / 10 : null;

  const levels = hopLevelsDb(pcm);
  const env = onsetEnvelope(levels);
  const beat = trackBeat(env, durationSec);

  let speechRatio: number | null = null;
  let musicRatio: number | null = null;
  let sfxOnsetsSec: number[] = [];
  if (speech) {
    const speechSec = speech.reduce((sum, [s, e]) => sum + Math.max(0, Math.min(e, durationSec) - Math.max(s, 0)), 0);
    speechRatio = Math.min(1, speechSec / durationSec);
    let bed = 0;
    curve.forEach((v, i) => {
      const t = (i + 0.5) / LOUDNESS_HZ;
      if (v > BED_DB && !inAny(t, speech)) bed++;
    });
    musicRatio = Math.min(1, bed / LOUDNESS_HZ / durationSec);

    for (let i = 1; i < env.length; i++) {
      const t = i / ENV_HZ;
      const isPeak = env[i] >= env[i - 1] && env[i] >= (env[i + 1] ?? 0);
      if (!isPeak || env[i] < SFX_JUMP_DB || levels[i] < SFX_FLOOR_DB || inAny(t, speech)) continue;
      const last = sfxOnsetsSec[sfxOnsetsSec.length - 1];
      if (last !== undefined && t - last < ONSET_MERGE_SEC) continue;
      sfxOnsetsSec.push(Math.round(t * 1000) / 1000);
      if (sfxOnsetsSec.length >= MAX_SFX_ONSETS) break;
    }
  } else {
    sfxOnsetsSec = [];
  }

  return { present: true, loudnessHz: LOUDNESS_HZ, loudnessDb: curve, loudnessMeanDb, loudnessRangeDb, speechRatio, musicRatio, beat, sfxOnsetsSec };
};

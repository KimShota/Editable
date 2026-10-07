import { z } from "zod";
import { WordSchema } from "../pipeline/schemas";

/**
 * VideoAnalysis — the ONE record every consumer reads about a video
 * (creator-brand-memory plan, section 3A). The same analyzer produces it for
 * a creator's published reels (to learn their style) and for the pipeline's
 * own rendered output (to score it against that style), which is what makes
 * an "on-brand score" possible: both sides are measured with the same ruler.
 *
 * Layering (carried over from the vlog redesign plan): everything here is
 * MEASURED by ffmpeg/DSP first. `transcript` comes from whisper, `captions`
 * from OCR, `semantic` from an LLM that is asked only about meaning — never
 * for a timestamp.
 *
 * Optional measurements are `null` when they could not be taken (no whisper
 * model on this box, no tesseract, no audio track) — never a made-up zero.
 * Consumers must treat null as "unknown", and `warnings` says why.
 */

const Quantiles = z.object({
  p10: z.number(),
  p50: z.number(),
  p90: z.number(),
  mean: z.number(),
});
export type Quantiles = z.infer<typeof Quantiles>;

export const CutSchema = z.object({
  atSec: z.number(),
  /** "hard": ffmpeg scene detection fired. "jump": no scene change, but a
   *  frame-pair spike whose second frame is a magnified view of the first —
   *  a same-take punch-in cut that scene detection cannot see. */
  kind: z.enum(["hard", "jump"]),
});

export const PunchInSchema = z.object({
  atSec: z.number(),
  /** How much the picture is magnified across the cut (>1 in, <1 out). */
  scale: z.number(),
  direction: z.enum(["in", "out"]),
});

export const SemanticSchema = z.object({
  topic: z.string(),
  hookType: z.enum(["question", "bold-claim", "visual-shock", "story", "tutorial", "list", "other"]),
  formatType: z.enum(["talking-head", "vlog", "tutorial", "listicle", "storytime", "montage", "product", "other"]),
  tone: z.array(z.string()).max(4),
  language: z.string(),
  overlayKinds: z.array(z.string()).max(6),
});
export type Semantic = z.infer<typeof SemanticSchema>;

export const VideoAnalysisSchema = z.object({
  analyzerVersion: z.string(),
  contentHash: z.string().nullable(),
  media: z.object({
    durationSec: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
    hasAudio: z.boolean(),
  }),
  cuts: z.array(CutSchema),
  shots: z.array(z.object({ startSec: z.number(), endSec: z.number() })),
  cutLenSec: Quantiles,
  /** 4x4-block frame differencing (see visual.ts): `subject` is movement in
   *  a few blocks (a person doing something), `shake` is movement in ALL
   *  blocks at once (the camera moving). Both sampled at `hz`, in 0-255
   *  gray-level units of mean absolute difference between adjacent frames. */
  motion: z.object({
    hz: z.number().positive(),
    subject: z.array(z.number()),
    shake: z.array(z.number()),
    subjectMean: z.number(),
    shakeMean: z.number(),
  }),
  punchIns: z.array(PunchInSchema),
  audio: z.object({
    present: z.boolean(),
    /** 10 Hz dBFS curve. Empty when there is no audio. */
    loudnessHz: z.number().positive(),
    loudnessDb: z.array(z.number()),
    loudnessMeanDb: z.number().nullable(),
    loudnessRangeDb: z.number().nullable(),
    /** Fraction of the video covered by speech (from the transcript). */
    speechRatio: z.number().min(0).max(1).nullable(),
    /** Fraction that is audible but not speech — a music or ambience bed.
     *  A heuristic split, not a classifier. */
    musicRatio: z.number().min(0).max(1).nullable(),
    beat: z.object({
      bpm: z.number().nullable(),
      /** 0-1: how periodic the onset track is. Low = no steady beat. */
      confidence: z.number().min(0).max(1),
      beatTimesSec: z.array(z.number()),
    }),
    /** Strong sound onsets outside speech — the SFX/hit candidates. Empty
     *  when speech is unknown (a consonant would read as an "SFX"). */
    sfxOnsetsSec: z.array(z.number()),
  }),
  transcript: z
    .object({
      words: z.array(WordSchema),
      wordsPerMin: z.number().nullable(),
      /** Transcribed from the vocals alone (music removed by Demucs), not the full mix. Absent on analyses made before. */
      vocalsSeparated: z.boolean().optional(),
    })
    .nullable(),
  captions: z.object({
    /** OCR ran. False = unmeasured, and every other field is null. */
    measured: z.boolean(),
    /** Fraction of sampled frames with on-screen text. */
    coverage: z.number().nullable(),
    /** Median words on screen in frames that have text. */
    medianWords: z.number().nullable(),
    position: z.enum(["top", "middle", "bottom"]).nullable(),
    /** A heuristic read of coverage × words — see captions.ts. */
    mode: z.enum(["none", "karaoke", "keyword", "full"]).nullable(),
  }),
  grade: z.object({
    lumaMean: z.number(),
    lumaP5: z.number(),
    lumaP50: z.number(),
    lumaP95: z.number(),
    /** Mean HSV saturation, 0-1. */
    satMean: z.number(),
    /** (mean R − mean B) / 255: -1 cool .. +1 warm. */
    warmth: z.number(),
  }),
  semantic: SemanticSchema.nullable(),
  warnings: z.array(z.string()),
});
export type VideoAnalysis = z.infer<typeof VideoAnalysisSchema>;

/**
 * StyleFeatures — the flat, per-video numeric summary of a VideoAnalysis
 * (plan 3A: "a flat numeric vector for each video"). Everything the style
 * engine compares or embeds comes from here, so a video and a StyleSpec are
 * measured in the same terms. A null is "unknown", and stays null: the
 * vector projection (style/vector.ts) marks it unknown rather than
 * imputing a number the distance would then trust.
 */
const nullableNumber = z.number().nullable();

export const StyleFeaturesSchema = z.object({
  durationSec: z.number(),
  cutsPerMin: z.number(),
  cutLenP10: z.number(),
  cutLenP50: z.number(),
  cutLenP90: z.number(),
  /** Length of the first shot — how long until the first cut. */
  hookSec: z.number(),
  /** Share of shots that are long takes (see features.ts LONG_TAKE_SEC). */
  longTakeRate: z.number(),
  /** Share of shots inside a fast montage run. */
  montageRunRate: z.number(),
  /** Punch-in cuts as a share of all cuts. */
  punchInRate: z.number(),
  /** Median magnification of the punch-ins, null if there are none. */
  zoomScale: nullableNumber,
  /** Mean subject-motion energy, 0-1 (motion.subjectMean / ENERGY_FULL_SCALE). */
  energy: z.number(),
  /** Mean camera shake, 0-1. */
  shake: z.number(),
  captionCoverage: nullableNumber,
  captionWords: nullableNumber,
  sfxPerMin: nullableNumber,
  musicRatio: nullableNumber,
  beatStrength: nullableNumber,
  speechRatio: nullableNumber,
  wordsPerMin: nullableNumber,
  loudnessMeanDb: nullableNumber,
  loudnessRangeDb: nullableNumber,
  lumaMean: z.number(),
  /** lumaP95 − lumaP5, 0-1: how much tonal range the picture uses. */
  lumaSpread: z.number(),
  satMean: z.number(),
  warmth: z.number(),
});
export type StyleFeatures = z.infer<typeof StyleFeaturesSchema>;

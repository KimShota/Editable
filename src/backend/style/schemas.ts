import { z } from "zod";
import { GradeSchema } from "../pipeline/schemas";
import { SemanticSchema } from "../analysis/schemas";
import { STYLE_DIM_COUNT } from "./dims";

/**
 * StyleSpec — HOW a video is cut and dressed (creator-brand-memory plan,
 * section 1): pacing, in-points, structure, transitions, camera, captions,
 * overlays, audio and grade. It is one of three separate objects:
 *
 *   Format    what the video is made of (formats/*.json — unchanged)
 *   StyleSpec how it is cut and dressed (this)
 *   BrandKit  who it must stay (M1)
 *
 * A StyleSpec can be MEASURED from finished videos (yours or another
 * creator's), taken from a template, or mapped from a text description —
 * `source` records which. The `editStyle.json` proposed in
 * plan/daily-vlog-autoedit-redesign.md becomes the per-format instance of
 * this same schema.
 *
 * Field meanings match the analyzer's StyleFeatures (analysis/schemas.ts),
 * so a spec and a measured video live in one space (dims.ts / vector.ts).
 */

/** p10 <= p50 <= p90, all non-negative. */
const Quantiles = z
  .object({ p10: z.number().nonnegative(), p50: z.number().nonnegative(), p90: z.number().nonnegative() })
  .refine((q) => q.p10 <= q.p50 && q.p50 <= q.p90, { message: "quantiles must satisfy p10 <= p50 <= p90" });

const unit = z.number().min(0).max(1);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected a #rrggbb color");

export const ClipKindSchema = z.enum(["talking", "action", "static", "broll"]);
export type ClipKind = z.infer<typeof ClipKindSchema>;

export const InPointAnchorSchema = z.enum(["settle", "firstWord", "motionPeak", "clipHead"]);

export const CaptionModeSchema = z.enum(["none", "karaoke", "keyword", "full"]);
export type CaptionMode = z.infer<typeof CaptionModeSchema>;

export const StyleSourceKindSchema = z.enum(["self", "creator", "template", "text"]);

export const StyleSpecSchema = z.object({
  version: z.literal(1),
  source: z.object({
    kind: StyleSourceKindSchema,
    /** What it came from: a user id, a video/creator ref, a template id or
     *  the description text. Free-form provenance, never parsed. */
    ref: z.string().max(500),
  }),
  pacing: z.object({
    /** Cut-length distribution per kind of clip: a talking-head holds longer
     *  than action. A kind absent here means "not observed", not zero. */
    cutLenSec: z.object({ byClipKind: z.partialRecord(ClipKindSchema, Quantiles) }),
    cutsPerMin: z.number().min(0).max(120),
    hookSec: z.number().min(0).max(30),
    totalSec: z
      .object({ p50: z.number().positive(), min: z.number().positive(), max: z.number().positive() })
      .refine((t) => t.min <= t.p50 && t.p50 <= t.max, { message: "totalSec must satisfy min <= p50 <= max" }),
    /** Normalized motion energy across the video, 0-1, evenly spaced. */
    energyCurve: z.array(unit).max(64).default([]),
  }),
  inPoint: z.object({
    /** Where in a raw clip the cut starts, per kind. `offsetSec` after the
     *  anchor, with `sdSec` the spread the creator actually shows. */
    byClipKind: z.partialRecord(
      ClipKindSchema,
      z.object({ anchor: InPointAnchorSchema, offsetSec: z.number(), sdSec: z.number().nonnegative() }),
    ),
  }),
  structure: z.object({
    hookPattern: SemanticSchema.shape.hookType,
    ctaPattern: z.string().max(80),
    montage: z.object({ runRate: unit, runLenP50: z.number().nonnegative(), memberLenP50: z.number().nonnegative() }),
    longTake: z.object({ rate: unit, p50Sec: z.number().nonnegative() }),
  }),
  /** `kind` is an EDL transition component name (e.g. "cut", "fade"). */
  transitions: z.array(z.object({ kind: z.string().min(1).max(40), rate: unit })).max(16),
  camera: z.object({
    /** Share of cuts that are punch-ins. */
    punchInRate: unit,
    zoomScale: z.number().min(1).max(2),
  }),
  captions: z.object({
    mode: CaptionModeSchema,
    /** A font key from the renderer's registry; null = the default face. */
    fontRef: z.string().max(80).nullable(),
    colors: z.object({ text: color, highlight: color.optional(), background: color.optional() }),
    position: z.enum(["top", "middle", "bottom"]),
    wordsPerGroup: z.number().int().min(1).max(12),
    emphasis: z.enum(["none", "color", "scale", "bold"]),
  }),
  overlays: z.object({
    densityPerMin: z.number().min(0).max(60),
    kinds: z.array(z.string().max(40)).max(12),
  }),
  audio: z.object({
    musicEnergy: unit,
    /** How hard the music dips under speech: 0 none .. 1 strong. */
    ducking: unit,
    sfxPerMin: z.number().min(0).max(60),
    sfxVocab: z.array(z.string().max(40)).max(24),
    /** How tightly cuts snap to the beat: 0 not at all .. 1 always. */
    beatSync: unit,
  }),
  grade: GradeSchema,
  /**
   * Derived from the fields above (vector.ts `deriveEmbedding`) — never
   * authored. Optional so a hand-written spec validates before it is
   * finalized; when present it must be the full embedding width.
   */
  embedding: z.array(z.number()).length(STYLE_DIM_COUNT).optional(),
});
export type StyleSpec = z.infer<typeof StyleSpecSchema>;

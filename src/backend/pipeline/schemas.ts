import { z } from "zod";

/**
 * Phase 0 — the fixed contracts every pipeline stage builds against.
 *
 * These zod schemas are the single source of truth; the TypeScript types
 * in types.ts are inferred from them. Every artifact that flows between
 * stages (FilledFormat, Transcript, TrimPoints, ResolvedRoles, EDL) is
 * validated against these schemas, which is what makes each stage
 * independently runnable and inspectable.
 *
 * TIME CONVENTIONS (the trim-then-time rule):
 *   - Transcript words:      seconds relative to the RAW clip.
 *   - TrimPoints:            srcIn/srcOut in RAW clip seconds.
 *   - ResolvedRoles.timeSec: seconds relative to the TRIMMED block start
 *                            (the LLM sees a trim-shifted transcript).
 *   - EDL tl* fields:        absolute seconds on the final timeline.
 */

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/**
 * A reference to a reusable renderer component plus its parameters.
 * Format configs never contain animation code — only these references.
 *
 * Slot indirection: overlay params may use `textSlot` / `imageSlot`
 * (slot names) instead of literal `text` / `src`. Assembly resolves them
 * against the job's bindings so the EDL is fully self-contained.
 */
export const ComponentRefSchema = z.object({
  component: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
});

export const AnchorPointSchema = z.enum(["blockStart", "blockEnd"]);

/** Deterministic position inside a block: anchor point + signed offset. */
export const AnchoredTimeSchema = z.object({
  anchor: AnchorPointSchema,
  /** Seconds after (positive) or before (negative) the anchor. */
  offsetSec: z.number(),
});

/**
 * Anchors: how overlay/SFX timing is found in each user's own transcript.
 *
 * LITERAL anchors are fixed words the instruction told the user to say
 * ("First is …"). They're found by fuzzy text matching — no LLM — and are
 * near-certain, so they double as scaffolding: block markers whose spans
 * bound the search windows for everything else. With `capture`, the words
 * the user speaks right after the phrase (their own name for the item) are
 * captured, stopping at a pause, a sentence break, or the fixed
 * continuation in `captureUntil`. Captured text is content: overlays can
 * reference it via a `textAnchor` param.
 *
 * SEMANTIC anchors are content moments spoken freely in the user's own
 * words. The config carries a reference description plus a light form
 * constraint ("one sentence, starts with a verb"); an LLM locates the
 * matching SPAN (start and end) — searching only inside `window`, which is
 * bounded by literal anchors, when one is given.
 *
 * Every anchor resolves to a span and carries a fallback structural
 * position for when matching confidence is low: output is never broken,
 * just occasionally less precisely timed.
 */

/** Search window for a semantic anchor, bounded by LITERAL anchor ids. */
export const AnchorWindowSchema = z.object({
  /** Search starts where this literal anchor's span ends. */
  afterAnchor: z.string().optional(),
  /** Search ends where this literal anchor's span starts. */
  beforeAnchor: z.string().optional(),
});

export const LiteralAnchorSchema = z.object({
  id: z.string(),
  kind: z.literal("literal"),
  /** The fixed words the instruction tells the user to say. */
  phrase: z.string().min(1),
  /** Capture the user's own words following the phrase. */
  capture: z.boolean().default(false),
  /** Fixed continuation that terminates the capture ("and I'll …"). */
  captureUntil: z.string().optional(),
  fallback: AnchoredTimeSchema,
});

/** Legacy `roles` entries parse as semantic anchors (kind defaults). */
export const SemanticAnchorSchema = z.object({
  id: z.string(),
  kind: z.literal("semantic").default("semantic"),
  description: z.string(),
  /** Light form constraint, e.g. "one sentence, starts with a verb". */
  form: z.string().optional(),
  window: AnchorWindowSchema.optional(),
  fallback: AnchoredTimeSchema,
  /** Span length assumed when the end is needed but resolution fell back. */
  fallbackDurationSec: z.number().min(0).default(1),
});

export const AnchorSchema = z.union([LiteralAnchorSchema, SemanticAnchorSchema]);

export const MediaTypeSchema = z.enum(["video", "image", "audio", "text"]);

/** A named slot the user fills: a file (video/image/audio) or a text string. */
export const SlotSchema = z.object({
  name: z.string(),
  mediaType: MediaTypeSchema,
  required: z.boolean().default(true),
  /** Filming / sourcing instructions shown to the user. */
  instructions: z.string(),
});

/**
 * When an event fires: at a resolved anchor (kind "role", the historical
 * name), or at a fixed anchored time. Anchor timings pick an `edge` of the
 * resolved span and may nudge from it with `offsetSec`.
 */
export const EventTimingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("role"),
    roleId: z.string(),
    /** captureStart = where a literal anchor's captured words begin. */
    edge: z.enum(["start", "end", "captureStart"]).default("start"),
    offsetSec: z.number().default(0),
  }),
  z.object({ kind: z.literal("fixed") }).extend(AnchoredTimeSchema.shape),
]);

/** An overlay or sound-effect event authored in the format. */
export const FormatEventSchema = z.object({
  id: z.string(),
  kind: z.enum(["overlay", "sfx"]),
  component: ComponentRefSchema,
  timing: EventTimingSchema,
  /** How long an overlay stays up. Omitted = until the end of the block. */
  durationSec: z.number().positive().optional(),
  /**
   * When the event ends — e.g. the painpoint text ends at the moment the
   * resolve anchor fires, or a click SFX is cut at the keyword's end.
   * Takes precedence over durationSec.
   */
  until: EventTimingSchema.optional(),
});

// ---------------------------------------------------------------------------
// Format — the founder's judgment encoded as data
// ---------------------------------------------------------------------------

export const BlockSchema = z.object({
  id: z.string(),
  /** Human label, e.g. "Hook". */
  title: z.string(),
  /** voice = spoken, gets transcription/trim/roles; broll = silent footage. */
  kind: z.enum(["voice", "broll"]),
  /** Which of this block's slots holds the main footage. */
  videoSlot: z.string(),
  slots: z.array(SlotSchema),
  /** Whether to burn word captions for this block (voice blocks only). */
  captions: z.boolean().default(false),
  /** Broll blocks: how long to show the clip (min'd with actual length). */
  brollDurationSec: z.number().positive().optional(),
  /** Optional hard cap on the block's duration after trim. */
  maxDurationSec: z.number().positive().optional(),
  /** Legacy field: semantic anchors only. New formats use `anchors`. */
  roles: z.array(SemanticAnchorSchema).default([]),
  anchors: z.array(AnchorSchema).default([]),
  events: z.array(FormatEventSchema).default([]),
  /** Transition into the NEXT block. Omitted = hard cut. */
  transitionAfter: ComponentRefSchema.optional(),
});

export const FormatSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    niche: z.string(),
    description: z.string().default(""),
    fps: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    /** Caption look, shared by all captioned blocks. */
    captionStyle: ComponentRefSchema.optional(),
    /** Optional user-supplied music bed for the whole video. */
    musicSlot: SlotSchema.optional(),
    musicVolume: z.number().min(0).max(1).default(0.5),
    /** Slots used by events across many blocks (shared SFX, recurring memes). */
    sharedSlots: z.array(SlotSchema).default([]),
    blocks: z.array(BlockSchema).min(1),
  })
  .superRefine((format, ctx) => {
    const slotNames = new Set<string>();
    const addSlot = (name: string) => {
      if (slotNames.has(name)) {
        ctx.addIssue({ code: "custom", message: `duplicate slot name "${name}"` });
      }
      slotNames.add(name);
    };
    if (format.musicSlot) addSlot(format.musicSlot.name);
    for (const slot of format.sharedSlots) addSlot(slot.name);

    const blockIds = new Set<string>();
    const eventIds = new Set<string>();
    for (const block of format.blocks) {
      if (blockIds.has(block.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate block id "${block.id}"` });
      }
      blockIds.add(block.id);

      for (const slot of block.slots) addSlot(slot.name);

      const videoSlot = block.slots.find((s) => s.name === block.videoSlot);
      if (!videoSlot) {
        ctx.addIssue({
          code: "custom",
          message: `block "${block.id}": videoSlot "${block.videoSlot}" is not declared in its slots`,
        });
      } else if (videoSlot.mediaType !== "video") {
        ctx.addIssue({
          code: "custom",
          message: `block "${block.id}": videoSlot "${block.videoSlot}" must have mediaType "video"`,
        });
      }

      const anchors = [...block.roles, ...block.anchors];
      if (block.kind === "broll" && anchors.length > 0) {
        ctx.addIssue({
          code: "custom",
          message: `block "${block.id}": broll blocks cannot define anchors (no transcript to resolve against)`,
        });
      }
      if (block.kind === "broll" && block.captions) {
        ctx.addIssue({
          code: "custom",
          message: `block "${block.id}": broll blocks cannot have captions`,
        });
      }

      const anchorIds = new Set<string>();
      const literalIds = new Set<string>();
      for (const anchor of anchors) {
        if (anchorIds.has(anchor.id)) {
          ctx.addIssue({
            code: "custom",
            message: `duplicate anchor id "${anchor.id}" in block "${block.id}"`,
          });
        }
        anchorIds.add(anchor.id);
        if (anchor.kind === "literal") literalIds.add(anchor.id);
      }
      // Windows may only be bounded by literal anchors: literals resolve
      // first (no LLM), so their spans exist before any semantic search.
      for (const anchor of anchors) {
        if (anchor.kind !== "semantic" || !anchor.window) continue;
        for (const ref of [anchor.window.afterAnchor, anchor.window.beforeAnchor]) {
          if (ref !== undefined && !literalIds.has(ref)) {
            ctx.addIssue({
              code: "custom",
              message: `anchor "${anchor.id}": window must reference a LITERAL anchor in block "${block.id}", got "${ref}"`,
            });
          }
        }
      }

      for (const event of block.events) {
        if (eventIds.has(event.id)) {
          ctx.addIssue({ code: "custom", message: `duplicate event id "${event.id}"` });
        }
        eventIds.add(event.id);
        if (event.timing.kind === "role" && !anchorIds.has(event.timing.roleId)) {
          ctx.addIssue({
            code: "custom",
            message: `event "${event.id}": unknown anchor "${event.timing.roleId}" in block "${block.id}"`,
          });
        }
        if (event.until?.kind === "role" && !anchorIds.has(event.until.roleId)) {
          ctx.addIssue({
            code: "custom",
            message: `event "${event.id}": unknown "until" anchor "${event.until.roleId}" in block "${block.id}"`,
          });
        }
      }
    }
  });

// ---------------------------------------------------------------------------
// Job manifest + FilledFormat — intake and slot binding
// ---------------------------------------------------------------------------

/**
 * How the user fills a slot in job.json: a file path (job-dir-relative),
 * MULTIPLE file paths (a voice block's main clip only — see intake.ts —
 * filmed as separate takes and auto-ordered/concatenated downstream), or
 * text.
 */
export const SlotFillSchema = z.union([
  z.object({ file: z.string() }),
  z.object({ files: z.array(z.string()).min(1) }),
  z.object({ text: z.string() }),
]);

export const OverridesSchema = z.object({
  /**
   * Per-event nudges/swaps, keyed by event id.
   * timeSec is relative to the event's block start (trimmed timeline),
   * i.e. the same space as ResolvedRoles.timeSec.
   */
  events: z
    .record(
      z.string(),
      z.object({
        timeSec: z.number().optional(),
        component: ComponentRefSchema.optional(),
      }),
    )
    .default({}),
  /** Transition swaps, keyed by the block id whose transitionAfter changes. */
  transitions: z.record(z.string(), ComponentRefSchema).default({}),
});

export const JobManifestSchema = z.object({
  format: z.string(),
  bindings: z.record(z.string(), SlotFillSchema),
  overrides: OverridesSchema.optional(),
});

/** One probed file — shared shape between a single-file binding and each
 *  entry of a multi-take binding. */
export const BoundFileSchema = z.object({
  /** Path exactly as written in job.json (for readable artifacts). */
  path: z.string(),
  /** Resolved absolute path used by later stages. */
  absPath: z.string(),
  mediaType: z.enum(["video", "image", "audio"]),
  durationSec: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  hasAudio: z.boolean().optional(),
});

/** A slot binding after validation, with probed media metadata attached. */
export const BoundAssetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file") }).extend(BoundFileSchema.shape),
  /** Multiple takes for one slot — see intake.ts for where this is allowed
   *  (a voice block's main clip only). Order here is UPLOAD order; the
   *  transcribe stage decides playback order. */
  z.object({ type: z.literal("files"), files: z.array(BoundFileSchema).min(1) }),
  z.object({ type: z.literal("text"), text: z.string() }),
]);

export const FilledFormatSchema = z.object({
  jobId: z.string(),
  jobDir: z.string(),
  formatId: z.string(),
  bindings: z.record(z.string(), BoundAssetSchema),
  overrides: OverridesSchema.optional(),
});

// ---------------------------------------------------------------------------
// Transcript — word-level timestamps per voice block (RAW clip time)
// ---------------------------------------------------------------------------

export const WordSchema = z.object({
  text: z.string(),
  startSec: z.number(),
  endSec: z.number(),
});

export const BlockTranscriptSchema = z.object({
  blockId: z.string(),
  /** takeOrder[i] = the original upload index now playing at position i
   *  ([0] for an ordinary single-clip block). Decided once, here, since
   *  this is the earliest stage with each take's own words to order by. */
  takeOrder: z.array(z.number().int().min(0)).min(1),
  /** Raw (per-take-file) word timestamps, one array per take, already
   *  reordered to playback position (parallel to takeOrder). */
  takes: z.array(z.array(WordSchema)).min(1),
});

export const TranscriptSchema = z.object({
  blocks: z.array(BlockTranscriptSchema),
});

// ---------------------------------------------------------------------------
// TrimPoints — dead air removed (RAW clip time)
// ---------------------------------------------------------------------------

/** One take's trimmed span, in that take's own raw-clip seconds. */
export const TakeTrimSchema = z.object({
  srcInSec: z.number().min(0),
  srcOutSec: z.number().positive(),
});

export const BlockTrimSchema = z.object({
  blockId: z.string(),
  /** One entry per take, in playback order (parallel to the block's
   *  BlockTranscript.takes) — concatenated back-to-back, this is the
   *  block's full trimmed duration. A single-clip block just has one. */
  takes: z.array(TakeTrimSchema).min(1),
});

export const TrimPointsSchema = z.object({
  blocks: z.array(BlockTrimSchema),
});

// ---------------------------------------------------------------------------
// ResolvedRoles — resolved anchor spans (TRIMMED block time)
// ---------------------------------------------------------------------------

export const ResolvedRoleSchema = z.object({
  blockId: z.string(),
  roleId: z.string(),
  /** Span start, seconds from the start of the block's trimmed clip. */
  timeSec: z.number().min(0),
  /** Span end. Omitted on legacy point anchors; treated as == timeSec. */
  endSec: z.number().min(0).optional(),
  /** Where a literal anchor's captured words begin (the "[name]" start). */
  captureStartSec: z.number().min(0).optional(),
  confidence: z.number().min(0).max(1),
  /** literal = fuzzy text match (no LLM). */
  source: z.enum(["literal", "llm", "fallback"]),
  /** The transcript words matched/anchored to — for inspection. */
  quote: z.string().optional(),
  /** The user's own words captured after a literal phrase ("[name]"). */
  capturedText: z.string().optional(),
});

export const ResolvedRolesSchema = z.object({
  resolver: z.string(),
  roles: z.array(ResolvedRoleSchema),
});

// ---------------------------------------------------------------------------
// EDL — the master timeline; a complete description of the finished video
// ---------------------------------------------------------------------------

export const EdlVideoSegmentSchema = z.object({
  /** Stable clip id — the timeline editor's addressing handle. Distinct
   *  segments may share a blockId (after a split), so id is the only
   *  field that's guaranteed unique. */
  id: z.string(),
  blockId: z.string(),
  /** public/-relative path (usable with Remotion staticFile). */
  src: z.string(),
  srcInSec: z.number().min(0),
  srcOutSec: z.number().positive(),
  /** Full duration of the source file, when known — lets a trim edge be
   *  dragged back out to reveal more of the original footage. */
  srcDurationSec: z.number().positive().optional(),
  tlInSec: z.number().min(0),
  tlOutSec: z.number().positive(),
  muted: z.boolean().default(false),
});

export const EdlOverlaySchema = z.object({
  /** The originating event id (override/debug handle). */
  id: z.string(),
  component: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  tlInSec: z.number().min(0),
  tlOutSec: z.number().positive(),
});

export const EdlSfxSchema = z.object({
  id: z.string(),
  src: z.string(),
  tlInSec: z.number().min(0),
  /** Cut the effect after this long (span-aligned SFX). Omitted = play out. */
  durationSec: z.number().positive().optional(),
  volume: z.number().min(0).max(1).default(1),
});

export const EdlCaptionWordSchema = z.object({
  text: z.string(),
  tlStartSec: z.number(),
  tlEndSec: z.number(),
});

export const EdlCaptionGroupSchema = z.object({
  id: z.string(),
  words: z.array(EdlCaptionWordSchema).min(1),
  tlInSec: z.number().min(0),
  tlOutSec: z.number().positive(),
});

export const EdlTransitionSchema = z.object({
  /** Video clip id this transition follows (it plays at that clip's cut). */
  afterClipId: z.string(),
  component: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  /** Absolute time of the cut. */
  atSec: z.number().min(0),
  durationSec: z.number().positive(),
});

export const EdlSchema = z.object({
  jobId: z.string(),
  formatId: z.string(),
  fps: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationSec: z.number().positive(),
  video: z.array(EdlVideoSegmentSchema).min(1),
  overlays: z.array(EdlOverlaySchema).default([]),
  sfx: z.array(EdlSfxSchema).default([]),
  captions: z.array(EdlCaptionGroupSchema).default([]),
  captionStyle: ComponentRefSchema.optional(),
  transitions: z.array(EdlTransitionSchema).default([]),
  music: z
    .object({
      src: z.string(),
      volume: z.number().min(0).max(1).default(0.5),
      /** Where the music bed starts on the timeline — movable/trimmable
       *  like any other clip, independent of the source audio file. */
      tlInSec: z.number().min(0).default(0),
      /** Omitted = plays to the end of the timeline. */
      durationSec: z.number().positive().optional(),
    })
    .optional(),
  /**
   * Staging map: public/-relative src → absolute source path. The render
   * stage copies these into public/ so staticFile can serve them. Purely
   * mechanical; carries no timing information.
   */
  assets: z.record(z.string(), z.string()).default({}),
});

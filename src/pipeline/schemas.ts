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

export const AnchorSchema = z.enum(["blockStart", "blockEnd"]);

/** Deterministic position inside a block: anchor + signed offset. */
export const AnchoredTimeSchema = z.object({
  anchor: AnchorSchema,
  /** Seconds after (positive) or before (negative) the anchor. */
  offsetSec: z.number(),
});

/**
 * A role: a plain-language description of the job a moment plays in the
 * structure ("the pivot from problem to solution"), NOT a keyword.
 * The LLM locates it in each user's transcript; the fallback position is
 * used when it can't do so confidently.
 */
export const RoleSchema = z.object({
  id: z.string(),
  description: z.string(),
  fallback: AnchoredTimeSchema,
});

export const MediaTypeSchema = z.enum(["video", "image", "audio", "text"]);

/** A named slot the user fills: a file (video/image/audio) or a text string. */
export const SlotSchema = z.object({
  name: z.string(),
  mediaType: MediaTypeSchema,
  required: z.boolean().default(true),
  /** Filming / sourcing instructions shown to the user. */
  instructions: z.string(),
});

/** When an event fires: at a resolved role, or at a fixed anchored time. */
export const EventTimingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("role"), roleId: z.string() }),
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
   * When an overlay ends (overlays only) — e.g. the painpoint text ends at
   * the moment the resolve role fires. Takes precedence over durationSec.
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
  roles: z.array(RoleSchema).default([]),
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

      if (block.kind === "broll" && block.roles.length > 0) {
        ctx.addIssue({
          code: "custom",
          message: `block "${block.id}": broll blocks cannot define roles (no transcript to resolve against)`,
        });
      }
      if (block.kind === "broll" && block.captions) {
        ctx.addIssue({
          code: "custom",
          message: `block "${block.id}": broll blocks cannot have captions`,
        });
      }

      const roleIds = new Set(block.roles.map((r) => r.id));
      for (const event of block.events) {
        if (eventIds.has(event.id)) {
          ctx.addIssue({ code: "custom", message: `duplicate event id "${event.id}"` });
        }
        eventIds.add(event.id);
        if (event.timing.kind === "role" && !roleIds.has(event.timing.roleId)) {
          ctx.addIssue({
            code: "custom",
            message: `event "${event.id}": unknown roleId "${event.timing.roleId}" in block "${block.id}"`,
          });
        }
        if (event.until) {
          if (event.kind !== "overlay") {
            ctx.addIssue({
              code: "custom",
              message: `event "${event.id}": "until" is only valid on overlay events`,
            });
          }
          if (event.until.kind === "role" && !roleIds.has(event.until.roleId)) {
            ctx.addIssue({
              code: "custom",
              message: `event "${event.id}": unknown "until" roleId "${event.until.roleId}" in block "${block.id}"`,
            });
          }
        }
      }
    }
  });

// ---------------------------------------------------------------------------
// Job manifest + FilledFormat — intake and slot binding
// ---------------------------------------------------------------------------

/** How the user fills a slot in job.json: a file path (job-dir-relative) or text. */
export const SlotFillSchema = z.union([
  z.object({ file: z.string() }),
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

/** A slot binding after validation, with probed media metadata attached. */
export const BoundAssetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("file"),
    /** Path exactly as written in job.json (for readable artifacts). */
    path: z.string(),
    /** Resolved absolute path used by later stages. */
    absPath: z.string(),
    mediaType: z.enum(["video", "image", "audio"]),
    durationSec: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    hasAudio: z.boolean().optional(),
  }),
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
  words: z.array(WordSchema),
});

export const TranscriptSchema = z.object({
  blocks: z.array(BlockTranscriptSchema),
});

// ---------------------------------------------------------------------------
// TrimPoints — dead air removed (RAW clip time)
// ---------------------------------------------------------------------------

export const BlockTrimSchema = z.object({
  blockId: z.string(),
  srcInSec: z.number().min(0),
  srcOutSec: z.number().positive(),
});

export const TrimPointsSchema = z.object({
  blocks: z.array(BlockTrimSchema),
});

// ---------------------------------------------------------------------------
// ResolvedRoles — the brain's output (TRIMMED block time)
// ---------------------------------------------------------------------------

export const ResolvedRoleSchema = z.object({
  blockId: z.string(),
  roleId: z.string(),
  /** Seconds from the start of the block's trimmed clip. */
  timeSec: z.number().min(0),
  confidence: z.number().min(0).max(1),
  source: z.enum(["llm", "fallback"]),
  /** The transcript words the LLM anchored to — for inspection. */
  quote: z.string().optional(),
});

export const ResolvedRolesSchema = z.object({
  resolver: z.string(),
  roles: z.array(ResolvedRoleSchema),
});

// ---------------------------------------------------------------------------
// EDL — the master timeline; a complete description of the finished video
// ---------------------------------------------------------------------------

export const EdlVideoSegmentSchema = z.object({
  blockId: z.string(),
  /** public/-relative path (usable with Remotion staticFile). */
  src: z.string(),
  srcInSec: z.number().min(0),
  srcOutSec: z.number().positive(),
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
  volume: z.number().min(0).max(1).default(1),
});

export const EdlCaptionWordSchema = z.object({
  text: z.string(),
  tlStartSec: z.number(),
  tlEndSec: z.number(),
});

export const EdlCaptionGroupSchema = z.object({
  words: z.array(EdlCaptionWordSchema).min(1),
  tlInSec: z.number().min(0),
  tlOutSec: z.number().positive(),
});

export const EdlTransitionSchema = z.object({
  /** Block id this transition follows (it plays at that block's cut). */
  afterBlockId: z.string(),
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
    .object({ src: z.string(), volume: z.number().min(0).max(1).default(0.5) })
    .optional(),
  /**
   * Staging map: public/-relative src → absolute source path. The render
   * stage copies these into public/ so staticFile can serve them. Purely
   * mechanical; carries no timing information.
   */
  assets: z.record(z.string(), z.string()).default({}),
});

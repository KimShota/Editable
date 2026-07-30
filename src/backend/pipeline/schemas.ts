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

/** A deterministic color grade — shared by StyleProfileSchema (where a
 *  format declares it) and EdlSchema (where assemble.ts carries it through
 *  for EdlVideo to apply as a CSS filter across every video segment). */
export const GradeSchema = z.object({
  saturation: z.number().positive().default(1),
  contrast: z.number().positive().default(1),
  brightness: z.number().default(0),
  /** -1 (cooler/blue) .. 1 (warmer/orange). */
  temperatureShift: z.number().min(-1).max(1).default(0),
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
  /** The fixed words the instruction tells the user to say — one entry per
   *  natural phrasing a user might actually speak (e.g. an instruction to
   *  say "First is" commonly comes back as "Number one is" instead). Every
   *  phrasing is tried; the best-scoring match wins. */
  phrases: z.array(z.string().min(1)).min(1),
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

/**
 * Marks a video slot as filled by the `generate` stage instead of the user
 * — an "insert" (a b-roll cutaway or montage clip) whose pixels are
 * synthesized from the job's identity photos + the format's StyleProfile,
 * rather than footage the user films. See generation/provider.ts.
 *
 * Scoped to inserts only (kind "cutaway" | "montage") — this never applies
 * to a voice block's own spoken clip, which is always the user's real
 * performance. If the user supplies their own file for a generation-marked
 * slot anyway, intake honors it as-is and generation is skipped for that
 * slot (a natural opt-out, no separate flag needed).
 */
/** Which of an identity photo's own poses a plateStill/detailStill draws
 *  on — see generation/identityPrep.ts's classifyPoses doc comment for how
 *  a job's uploaded photos get tagged. "other" is the catch-all a photo
 *  gets when it doesn't clearly match one of the rest. */
export const PoseTagSchema = z.enum(["standing", "closeup", "profile", "sitting", "other"]);

/** One sub-shot inside a montageReel/triptych — the same plateStill/
 *  detailStill/generatedScene shape GenerationSpecSchema itself uses,
 *  minus the fields (durationSec, subShots) that only make sense at the
 *  top level, plus "reuse" — a montageReel member that ISN'T generated at
 *  all, it re-plays another already-generated slot's own still (see
 *  generatedShots.ts's doc comment: e.g. the montage's own run reuses the
 *  beat shots rather than paying to generate near-duplicates). */
export const SubShotSpecSchema = z.object({
  kind: z.enum(["plateStill", "detailStill", "generatedScene", "reuse"]),
  shot: z.string(),
  /** plateStill/generatedScene only: which formats/assets/<formatId>/
   *  plate to composite/generate the chosen photo onto. */
  plate: z.string().optional(),
  treatment: z.enum(["lit", "silhouette"]).default("silhouette"),
  /** plateStill/generatedScene only: which pose tag's photo to use. */
  poseTag: PoseTagSchema.optional(),
  seed: z.number().int().default(0),
  /** generatedScene only: the POSE/FRAMING clause of the subject-into-
   *  scene prompt (see generatedShots.ts's buildScenePrompt). */
  posePrompt: z.string().optional(),
  /** reuse only: the OTHER slot name (within the same job) whose already-
   *  generated still to replay here — see generatedShots.ts's
   *  findGeneratedStill. */
  reuseSlot: z.string().optional(),
  /** reuse/generatedScene: which way the Ken-Burns push moves — lets a
   *  reused still get a visibly different push than the shot it's reused
   *  from, so the same source image doesn't read as a repeated shot. */
  panDirection: z.enum(["in", "out", "left", "right"]).optional(),
  /** triptych panels only — how this panel gets its own motion, instead
   *  of every panel sharing one flat Ken-Burns push over the whole
   *  stacked frame (the "still masquerading as a moving shot" defect:
   *  measured against the reference, its middle/cash panel moves ~24
   *  luma/frame vs a silhouette still's own ~0.5-1.5). "kenBurns"
   *  (default): the existing still + slow push, for panels the reference
   *  itself barely moves (shoes, ~4.6). "realCrop": crops a window of the
   *  job's own speaking-take footage instead of generating anything —
   *  identity-perfect, genuinely moving, free (the eyes panel). "dop":
   *  generates the panel's still exactly as today, then sends it through
   *  Higgsfield's DoP image2video for real motion (the cash panel, whose
   *  measured shuffle motion a still or a push can't approximate).
   *  "templateClip": plays a pre-built, format-shipped clip verbatim (see
   *  `templateClipPath`) — for a panel with no identity content at all
   *  (cash, shoes), built ONCE offline and reused free for every job,
   *  rather than paying for DoP on every single build. */
  motion: z.enum(["kenBurns", "realCrop", "dop", "templateClip"]).default("kenBurns"),
  /** motion:"realCrop" only — where to crop from, as a FRACTION (0-1) of
   *  the job's own speaking-take total duration, not an absolute second
   *  count: every user's take runs a different length depending on their
   *  own pacing, so a fixed second offset tuned against one job's ~10s
   *  take would crop the wrong moment (or past the end entirely) for
   *  anyone else's. A fraction scales with whatever the user actually
   *  recorded. 0.75 (this format's own default) lands late in the take,
   *  inside the final line for most users' own pacing. */
  realCropAtFrac: z.number().min(0).max(1).optional(),
  /** motion:"dop" only — the motion prompt sent to Higgsfield alongside
   *  the generated still (e.g. "a hand shuffles a stack of banknotes").
   *  Falls back to `shot` when omitted. */
  motionPrompt: z.string().optional(),
  /** motion:"templateClip" only — formatAssetsDir(formatId)-relative
   *  filename of the pre-built clip (checked into formats/assets/<id>/,
   *  same convention as PlateAssetSchema's own `file`) to play verbatim
   *  for this panel — resolved to an absolute path at generation time by
   *  modelShots.ts, never stored as one, so the format JSON stays
   *  portable across machines/deployments. */
  templateClipPath: z.string().optional(),
});

export const GenerationSpecSchema = z.object({
  kind: z.enum(["cutaway", "montage", "plateStill", "detailStill", "montageReel", "triptych", "generatedScene"]),
  /** Plain-language description of the shot to generate — environment,
   *  framing, action — combined with the format's StyleProfile to build
   *  the generation request. Not consumed by any renderer component. */
  shot: z.string(),
  durationSec: z.number().positive(),
  /** Pinned so re-running the stage reproduces the exact same clip
   *  (see generation/provider.ts's caching, keyed in part on this). */
  seed: z.number().int().default(0),
  /** plateStill/generatedScene only: which formats/assets/<formatId>/
   *  plate to composite/generate the chosen identity photo onto (see
   *  PlatesManifestSchema). */
  plate: z.string().optional(),
  /** plateStill/detailStill: "silhouette" crushes dark (matte.ts's
   *  SILHOUETTE_CRUSH); "lit" keeps relit-but-not-crushed brightness.
   *  generatedScene: drives which QC target band and prompt strength are
   *  used (see generatedShots.ts) — it does not crush anything itself,
   *  the model is asked to render the look directly. */
  treatment: z.enum(["lit", "silhouette"]).default("silhouette"),
  /** plateStill/generatedScene only: which of the job's identity photos
   *  to use as the primary pose donor (see identityPrep.ts). Omitted lets
   *  the provider pick by seed, same as the legacy cutaway/montage kinds
   *  did. generatedScene attaches ALL identity photos regardless — this
   *  only decides which one leads the reference order. */
  poseTag: PoseTagSchema.optional(),
  /** montageReel (concatenated into one clip) / triptych (stacked into
   *  one composite frame) only: the sub-shots that make it up. */
  subShots: z.array(SubShotSpecSchema).optional(),
  /** generatedScene only: the POSE/FRAMING clause of the subject-into-
   *  scene prompt — see generatedShots.ts's buildScenePrompt doc comment
   *  for the full prompt structure this slots into. */
  posePrompt: z.string().optional(),
});

/** A named slot the user fills: a file (video/image/audio) or a text string. */
export const SlotSchema = z.object({
  name: z.string(),
  mediaType: MediaTypeSchema,
  required: z.boolean().default(true),
  /** Filming / sourcing instructions shown to the user. */
  instructions: z.string(),
  /** Present = this slot is a generated insert, not user-filmed footage. */
  generation: GenerationSpecSchema.optional(),
});

/**
 * When an event fires: at a resolved anchor (kind "role", the historical
 * name), at a fixed anchored time, or as one member of a "sequence" — N
 * sibling events distributed across whatever runway actually exists after
 * an anchor, rather than each pinned to a hardcoded offset. A sequence
 * degrades gracefully: it compresses spacing to fit before it ever drops an
 * item, and only drops from the tail (highest `index` first) when even the
 * minimum spacing can't fit everyone in the available time.
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
  z.object({
    kind: z.literal("sequence"),
    roleId: z.string(),
    edge: z.enum(["start", "end", "captureStart"]).default("end"),
    /** This event's 0-based position among its siblings. */
    index: z.number().int().min(0),
    /** Total events sharing this sequence (every sibling repeats this). */
    count: z.number().int().min(1),
    /** Spacing between items when the runway comfortably fits them all. */
    targetGapSec: z.number().positive(),
    /** Never space tighter than this — items beyond what fits even here
     *  are dropped (highest index first), not crushed together. */
    minGapSec: z.number().positive().default(0.12),
  }),
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
  /** Only meaningful alongside captions:true. "lowerThird" (default): the
   *  ordinary multi-word caption line, always built for every captioned
   *  block regardless of this field. "bigTitle": ALSO build full-screen
   *  keyword-title cards (see `keywordTitle`) that render concurrently
   *  with the lowerThird line — the reference reel shows both layers at
   *  once, not one word-karaoke line replacing the other. "karaokeTitle":
   *  REPLACES lowerThird/bigTitle entirely with one full-screen Didone
   *  title card per word of the block's own line, shown one at a time in
   *  sequence (assemble.ts builds one EdlCaptionGroup carrying every
   *  word, each with its own tlStartSec/tlEndSec — KaraokeTitleLayer.tsx
   *  picks whichever is active). Positioned so its own baseline sits
   *  where the talking-head composite's own head-top lands (see
   *  PlatesManifestSchema's headTopFrac), which is what lets the subject
   *  occlude it — see EdlVideo.tsx's render order doc comment for why
   *  this needs a SEPARATE render pass from ordinary captions, not just
   *  another variant inside Captions.tsx. */
  captionVariant: z.enum(["lowerThird", "bigTitle", "karaokeTitle"]).default("lowerThird"),
  /** Only meaningful alongside captionVariant:"bigTitle". Which word(s) of
   *  the block get their own full-screen title card, instead of every
   *  word (the reference punches ONE chosen word per beat, not a karaoke
   *  line through the whole sentence). "capture": pick from a literal
   *  anchor's own captured span (see LiteralAnchorSchema) — free, already
   *  computed by resolveRoles. "llm" (name is aspirational; the current
   *  implementation is a deterministic salience heuristic — longest
   *  non-stopword words — not an actual model call, kept behind this name
   *  so a real LLM pick can slot in later without a template change):
   *  picks from the block's own words after its anchor's marker phrase
   *  ends, for a block whose anchor doesn't capture (e.g. `capture:
   *  false`, nothing to draw from directly). */
  keywordTitle: z
    .object({
      source: z.enum(["capture", "llm"]).default("capture"),
      maxWords: z.number().int().positive().default(1),
    })
    .optional(),
  /** Which Captions.tsx theme this block's captions render in — "kumar"
   *  (red, default, inherited from the format's captionStyle) or
   *  "outroYellow" (casual yellow lower-third, no bigTitle look, for a
   *  block that deliberately breaks the cinematic tone). Omitted = the
   *  format's own captionStyle theme. */
  captionTheme: z.string().optional(),
  /** Broll blocks: how long to show the clip (min'd with actual length). */
  brollDurationSec: z.number().positive().optional(),
  /** Voice blocks only, and only meaningful alongside speakingTakeSlot:
   *  swap this block's real background for a generated one, compositing
   *  the user's own matted-out footage on top (see backgroundReplace.ts).
   *  Every flagged block in a format shares ONE generated backdrop image
   *  (built from the StyleProfile's environment/lighting), matching a
   *  single-take format's own premise — one continuous take, one camera
   *  position, one set — never a per-block backdrop. */
  backgroundReplace: z.boolean().default(false),
  /** Voice blocks only: crops+zooms the last N seconds of this block's own
   *  footage into a tight close-up, cutting instantly (see
   *  videoEffects.ts's applyPunchInTail) — the reference reel's own
   *  emphasis-cutaway edit rhythm, built from footage that already
   *  exists rather than anything generated. */
  punchInTailSec: z.number().positive().optional(),
  /** Broll blocks only: composites the last brollDurationSec of this
   *  block's own bound clip onto a generated light vignette backdrop,
   *  crushed via the measured SILHOUETTE_CRUSH curve (matte.ts) — the
   *  reference reel's light-backdrop pose shots (see
   *  backgroundReplace.ts's doc comment). Distinct from
   *  backgroundReplace: a broll block owns its clip directly, there's no
   *  shared take to slice a span out of. Legacy shorthand for
   *  `plateComposite: { plate: "studio-cyc", treatment: "silhouette" }` —
   *  parses to exactly that in loader.ts, kept only so older format JSON
   *  keeps working unchanged. */
  silhouette: z.boolean().default(false),
  /** Broll blocks only: composites the last brollDurationSec of this
   *  block's own bound clip onto one of the format's checked-in template
   *  plates (formats/assets/<formatId>/, see PlatesManifestSchema) instead
   *  of a generated backdrop. "silhouette" crushes the subject dark
   *  (matte.ts's SILHOUETTE_CRUSH), matching today's `silhouette: true`;
   *  "lit" keeps the subject's own relit-but-not-crushed brightness — for
   *  shots the reference shows fully lit (e.g. the end card), where
   *  crushing to a silhouette would be wrong. Takes precedence over
   *  `silhouette` when both are set; backgroundReplace.ts's
   *  resolvePlateComposite() is the one place that reads either field, so
   *  the rest of the pipeline only ever sees the resolved shape. */
  plateComposite: z
    .object({
      plate: z.string(),
      treatment: z.enum(["lit", "silhouette"]).default("silhouette"),
    })
    .optional(),
  /** Voice blocks only: an ECU (extreme close-up) cutaway — crops+zooms a
   *  short, silent window of THIS block's own already-processed footage
   *  (after backgroundReplace, if flagged) and shows it as a
   *  CutawayOverlay elsewhere in the SAME block's timeline, free/no
   *  generation (videoEffects.ts's extractCloseUpCutaway). Self-
   *  referential by design for now — a different moment of the same clip,
   *  not footage borrowed from another block — the simplest version of
   *  the reference reel's ECU shots that still adds real cutting rhythm. */
  ecuCutaway: z
    .object({
      /** Where in the block's own clip to crop the close-up from. */
      atSec: z.number().min(0),
      durationSec: z.number().positive(),
      /** Where in the block's OWN TIMELINE to show it as a cutaway. */
      overlayAtSec: z.number().min(0),
    })
    .optional(),
  /** Optional hard cap on the block's duration after trim. */
  maxDurationSec: z.number().positive().optional(),
  /** Voice blocks only, single-take mode: this block is filmed as its OWN
   *  standalone clip (a bonus/CTA beat — different footage, sometimes a
   *  different person on camera — not another span of the shared take)
   *  AND is allowed to simply not exist in the final video if the user
   *  never filmed it. Excludes the block from speakingTakeSlot's clone-in
   *  (see FormatSchema's doc comment) so its own upload slot isn't
   *  overwritten by the shared take, and from splitTake's marker search.
   *  When bound, splitTake.deriveTranscriptAndTrimWithStandalone runs the
   *  ordinary transcribe/trim on it like any multi-clip-format block; when
   *  unbound, assemble.ts skips the block entirely (diagnostic, not an
   *  error) instead of throwing on a missing trim entry. */
  optional: z.boolean().default(false),
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
    /** Optional user-supplied music bed for the whole video. When unbound,
     *  assemble.ts falls back to the format's own checked-in template
     *  music bed (formats/assets/<id>/, PlatesManifestSchema's musicBed),
     *  when one exists — a format ships with a default score the same way
     *  it ships with default background plates, rather than shipping
     *  silent whenever a job skips this optional upload. */
    musicSlot: SlotSchema.optional(),
    musicVolume: z.number().min(0).max(1).default(0.5),
    /** How assemble.ts places the music bed on the timeline — omitted
     *  means "start" (today's implicit behavior: the bed starts at 0). */
    musicPlacement: z
      .object({
        /** "start": tlInSec 0. "montageOnset": tlInSec = the block whose
         *  own generated slot is a montageReel (see GenerationSpecSchema)
         *  — falls back to "start" if the format has no such block.
         *  "endAlign": same tlInSec as "montageOnset", but srcInSec is
         *  computed so the track's OWN tail lands exactly at the video's
         *  end, skipping however much of its head doesn't fit — for a
         *  bed whose climax/outro is near the end of the source file. */
        mode: z.enum(["start", "montageOnset", "endAlign"]).default("start"),
        fadeInSec: z.number().min(0).default(0.3),
        fadeOutSec: z.number().min(0).default(0.6),
        /** Volume multiplier under a voice block's own segment. */
        duckVolume: z.number().min(0).max(1).default(0.35),
      })
      .optional(),
    /** Slots used by events across many blocks (shared SFX, recurring memes). */
    sharedSlots: z.array(SlotSchema).default([]),
    /**
     * A set of reference photos of the performer (front/side/close-up, plus
     * optional extra angles) — the identity source the `generate` stage
     * conditions on for every generated insert. mediaType "image", filled
     * with a "files" binding (see intake.ts). Required only if some block
     * slot actually declares `generation`.
     */
    identitySlot: SlotSchema.optional(),
    /**
     * When set, every voice block's own video clip is DERIVED from this one
     * slot instead of being filmed/uploaded separately — "one continuous
     * take of all your lines," matching how some competing tools structure
     * filming. intake.ts clones this slot's bound file into every voice
     * block's own videoSlot binding, and a dedicated split stage
     * (splitTake.ts) locates each block's span inside it via the SAME
     * literal-anchor matching the rest of the pipeline already uses — so
     * transcribe/trim/resolveRoles/assemble need no changes; they still
     * just see one bound clip per block, they just happen to share a file.
     * mediaType must be "video". Mutually available alongside the
     * per-block-clip model (a format simply omits this to keep today's
     * per-block-upload behavior).
     */
    speakingTakeSlot: SlotSchema.optional(),
    /** A final clip that plays unedited at the very end, filmed/supplied
     *  separately from the speaking take — optional polish, mediaType
     *  "video". Only meaningful alongside speakingTakeSlot. */
    finalClipSlot: SlotSchema.optional(),
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
    if (format.identitySlot) addSlot(format.identitySlot.name);
    if (format.speakingTakeSlot) addSlot(format.speakingTakeSlot.name);
    if (format.finalClipSlot) addSlot(format.finalClipSlot.name);
    for (const slot of format.sharedSlots) addSlot(slot.name);

    if (format.identitySlot && format.identitySlot.mediaType !== "image") {
      ctx.addIssue({
        code: "custom",
        message: `identitySlot "${format.identitySlot.name}" must have mediaType "image"`,
      });
    }
    if (format.speakingTakeSlot && format.speakingTakeSlot.mediaType !== "video") {
      ctx.addIssue({
        code: "custom",
        message: `speakingTakeSlot "${format.speakingTakeSlot.name}" must have mediaType "video"`,
      });
    }
    if (format.finalClipSlot && format.finalClipSlot.mediaType !== "video") {
      ctx.addIssue({
        code: "custom",
        message: `finalClipSlot "${format.finalClipSlot.name}" must have mediaType "video"`,
      });
    }
    if (format.speakingTakeSlot && !format.blocks.some((b) => b.kind === "voice")) {
      ctx.addIssue({
        code: "custom",
        message: `speakingTakeSlot is set but the format has no voice blocks to derive clips for`,
      });
    }

    let hasGeneratedSlot = false;
    const blockIds = new Set<string>();
    const eventIds = new Set<string>();
    for (const block of format.blocks) {
      if (blockIds.has(block.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate block id "${block.id}"` });
      }
      blockIds.add(block.id);

      for (const slot of block.slots) {
        addSlot(slot.name);
        if (slot.generation) {
          hasGeneratedSlot = true;
          if (slot.mediaType !== "video") {
            ctx.addIssue({
              code: "custom",
              message: `block "${block.id}": generated slot "${slot.name}" must have mediaType "video"`,
            });
          }
        }
      }

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
      if (block.backgroundReplace && block.kind !== "voice") {
        ctx.addIssue({
          code: "custom",
          message: `block "${block.id}": backgroundReplace only applies to voice blocks`,
        });
      }
      if (block.backgroundReplace && !format.speakingTakeSlot) {
        ctx.addIssue({
          code: "custom",
          message: `block "${block.id}": backgroundReplace requires speakingTakeSlot (only meaningful in single-take mode)`,
        });
      }
      if (block.punchInTailSec !== undefined && block.kind !== "voice") {
        ctx.addIssue({
          code: "custom",
          message: `block "${block.id}": punchInTailSec only applies to voice blocks`,
        });
      }
      if (block.silhouette && block.kind !== "broll") {
        ctx.addIssue({
          code: "custom",
          message: `block "${block.id}": silhouette only applies to broll blocks`,
        });
      }
      if (block.plateComposite && block.kind !== "broll") {
        ctx.addIssue({
          code: "custom",
          message: `block "${block.id}": plateComposite only applies to broll blocks`,
        });
      }
      if (block.ecuCutaway && block.kind !== "voice") {
        ctx.addIssue({
          code: "custom",
          message: `block "${block.id}": ecuCutaway only applies to voice blocks`,
        });
      }
      if (block.optional && block.kind !== "voice") {
        ctx.addIssue({
          code: "custom",
          message: `block "${block.id}": optional only applies to voice blocks`,
        });
      }
      if (block.optional && !format.speakingTakeSlot) {
        ctx.addIssue({
          code: "custom",
          message: `block "${block.id}": optional only makes sense in single-take mode (speakingTakeSlot)`,
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
        if (
          (event.timing.kind === "role" || event.timing.kind === "sequence") &&
          !anchorIds.has(event.timing.roleId)
        ) {
          ctx.addIssue({
            code: "custom",
            message: `event "${event.id}": unknown anchor "${event.timing.roleId}" in block "${block.id}"`,
          });
        }
        if (
          (event.until?.kind === "role" || event.until?.kind === "sequence") &&
          !anchorIds.has(event.until.roleId)
        ) {
          ctx.addIssue({
            code: "custom",
            message: `event "${event.id}": unknown "until" anchor "${event.until.roleId}" in block "${block.id}"`,
          });
        }
      }
    }

    if (hasGeneratedSlot && !format.identitySlot) {
      ctx.addIssue({
        code: "custom",
        message: `format declares a generated slot but no "identitySlot" — generation has no identity photos to condition on`,
      });
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
  /** Domain vocabulary (proper nouns, brand names, coined terms) THIS
   *  video is expected to use — the format is reused across niches, so
   *  this belongs to the job's content, not the format's structure.
   *  Whisper has no reason to expect these and reliably mishears them;
   *  passed to the transcript-correction pass (see correctTranscript.ts)
   *  as a bias. Omitted/empty skips correction. */
  lexicon: z.array(z.string()).default([]),
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
  lexicon: z.array(z.string()).default([]),
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
  /** What trim() cut beyond plain dead air — a leading/trailing chunk
   *  judged to be filler rather than the scripted delivery — so it's
   *  visible instead of a silent edit decision. */
  diagnostics: z.array(z.string()).default([]),
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
  /** Independent of `muted` (which is all-or-nothing) — lets a clip's own
   *  audio be dialed down/up rather than only ever fully on or fully off. */
  volume: z.number().min(0).max(1).default(1),
  /** public/-relative path to this segment's own fg-alpha layer (subject
   *  cutout + desk foreground, transparent elsewhere — see matte.ts's
   *  compositeSubjectAlphaVideo), when backgroundReplace.ts built one.
   *  EdlVideo.tsx renders it as a SEPARATE layer above the karaoke title
   *  and below other overlays — see its own render-order doc comment. */
  fgSrc: z.string().optional(),
});

export const EdlOverlaySchema = z.object({
  /** The originating event id (override/debug handle). */
  id: z.string(),
  component: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  tlInSec: z.number().min(0),
  tlOutSec: z.number().positive(),
  /**
   * On-canvas box, as a fraction of the composition's width/height —
   * resolution-independent, and every overlay component already renders as
   * a full-frame, self-centering AbsoluteFill, so wrapping it in a box this
   * size/position (see EdlVideo.tsx) reproduces today's behavior exactly
   * at the default (0, 0, 1, 1) with zero changes inside the components.
   */
  x: z.number().default(0),
  y: z.number().default(0),
  width: z.number().positive().default(1),
  height: z.number().positive().default(1),
});

export const EdlSfxSchema = z.object({
  id: z.string(),
  src: z.string(),
  tlInSec: z.number().min(0),
  /** Where playback starts within the source file — skips a quiet lead-in
   *  a one-shot sfx asset commonly has (see assemble.ts/audioOnsetSec), so
   *  the audible part of the cue actually lands at tlInSec. */
  srcInSec: z.number().min(0).default(0),
  /** Cut the effect after this long (span-aligned SFX). Omitted = play out. */
  durationSec: z.number().positive().optional(),
  volume: z.number().min(0).max(1).default(1),
});

export const EdlCaptionWordSchema = z.object({
  text: z.string(),
  tlStartSec: z.number(),
  tlEndSec: z.number(),
  /** True when this word falls inside a literal anchor's captured span
   *  (the format author's own signal for "this is the thing that matters
   *  here" — a code's name, a captured keyword). Drives which words get
   *  the strong highlight treatment in Captions.tsx, instead of every
   *  currently-spoken word getting it regardless of semantic weight. */
  emphasis: z.boolean().default(false),
});

export const EdlCaptionGroupSchema = z.object({
  id: z.string(),
  words: z.array(EdlCaptionWordSchema).min(1),
  tlInSec: z.number().min(0),
  tlOutSec: z.number().positive(),
  /** Carried straight from the owning block's own captionVariant (see
   *  BlockSchema doc comment) — Captions.tsx renders each group according
   *  to its own tag, not one global style, since a format like this one
   *  wants BOTH a lower-third opening caption AND full-screen keyword
   *  titles over the same block, at the same time (two groups with
   *  overlapping tlIn/tlOut, one of each variant). */
  variant: z.enum(["lowerThird", "bigTitle", "karaokeTitle"]).default("lowerThird"),
  /** The owning block's own `captionTheme`, or the format's captionStyle
   *  theme when the block doesn't override it — see BlockSchema's doc
   *  comment. Captions.tsx picks its color/weight/casing from this. */
  theme: z.string().optional(),
});

export const EdlTransitionSchema = z.object({
  /** Video clip id this transition follows (it plays at that clip's cut). */
  afterClipId: z.string(),
  component: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  /** Absolute time of the cut. */
  atSec: z.number().min(0),
  /** 0 is valid — a "cut" component's transitionAfter is an instant cut
   *  with no animated duration (EdlVideo.tsx's IncomingTransition already
   *  clamps to at least one frame either way). Only an animated transition
   *  (fade, whooshZoom) needs a real positive value to have anything to
   *  animate over. */
  durationSec: z.number().nonnegative(),
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
  /** The format's StyleProfile grade (see StyleProfileSchema doc comment),
   *  carried straight through so EdlVideo can apply it as a CSS filter
   *  across every video segment uniformly — real footage and generated
   *  inserts alike, unlike generation/provider.ts's ffmpeg grade which
   *  only ever touched generated stills. */
  grade: GradeSchema.optional(),
  /** Where a karaokeTitle card's own baseline should sit (frame fraction)
   *  — carried straight through from the format's own talking-head
   *  headTopFrac (PlatesManifestSchema) when any block uses captionVariant
   *  "karaokeTitle", so KaraokeTitleLayer.tsx stays generic/data-driven
   *  (see EdlVideo.tsx's own doc comment: "new format = new config, not
   *  new components") instead of hardcoding a position that's specific to
   *  this one format's own head framing. */
  karaokeTitleBaselineFrac: z.number().min(0).max(1).optional(),
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
      /** Where playback starts within the source file — an end-aligned
       *  placement (see FormatSchema's musicPlacement) skips however much
       *  of the track's own head doesn't fit before the timeline ends. */
      srcInSec: z.number().min(0).default(0),
      fadeInSec: z.number().min(0).default(0),
      fadeOutSec: z.number().min(0).default(0),
      /** Volume multiplier applied while ANY duckWindow is active — 1
       *  means no ducking. Ramped, not stepped (see EdlVideo.tsx). */
      duckVolume: z.number().min(0).max(1).default(1),
      /** Absolute-timeline spans (typically every voice block's own
       *  segment) the music should duck under — spoken dialogue winning
       *  over the bed, ramped in/out rather than cut. */
      duckWindows: z.array(z.object({ tlInSec: z.number().min(0), tlOutSec: z.number().positive() })).default([]),
    })
    .optional(),
  /**
   * Staging map: public/-relative src → absolute source path. The render
   * stage copies these into public/ so staticFile can serve them. Purely
   * mechanical; carries no timing information.
   */
  assets: z.record(z.string(), z.string()).default({}),
  /** Every event/effect assemble() skipped or altered from what the format
   *  declared (unfilled slot, unmatched anchor, a sequence that didn't fit
   *  its runway, a duplicate sfx collapsed to one) — surfaced to the build
   *  UI instead of only a server-side console.warn. */
  diagnostics: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// StyleProfile — the visual DNA of a reference reel, hand-authored (v1)
// alongside a format at formats/<formatId>.style.json. Consumed only by the
// `generate` stage (generation/provider.ts) to condition generated inserts
// (cutaways/montage) so they read as the reference's aesthetic. Optional:
// a format with no generated slots needs no StyleProfile, and one with
// generated slots but no style file falls back to bland defaults rather
// than failing (see generation/styleProfile.ts).
// ---------------------------------------------------------------------------

export const StyleProfileSchema = z.object({
  formatId: z.string(),
  /** Plain-language description of the setting every generated insert
   *  should appear in, e.g. "modern accounting office, warm, binders on
   *  shelves behind the subject." */
  environment: z.string(),
  /** Plain-language lighting description, e.g. "hard key light from
   *  camera-left, cool color temperature, deep shadows." */
  lighting: z.string(),
  /** Deterministic grade applied to every generated insert (and, in a
   *  later phase, to the user's own real footage) via ffmpeg eq/colorbalance
   *  — cheap, GPU-free color-matching that alone captures a large slice of
   *  a reference's "cinematic look." */
  grade: GradeSchema.optional(),
});

// ---------------------------------------------------------------------------
// Plates — a format's checked-in template backdrops (formats/assets/<id>/),
// used by backgroundReplace.ts in place of per-job generated backdrops so
// every user gets the SAME set (see PlatesManifestSchema doc comment below).
// ---------------------------------------------------------------------------

export const PlateLumaStatsSchema = z.object({
  mean: z.number(),
  p5: z.number(),
  p50: z.number(),
  p90: z.number(),
  p95: z.number(),
});

export const PlateAssetSchema = z.object({
  /** formatAssetsDir(formatId)-relative filename, e.g. "office-dark.png". */
  file: z.string(),
  sha256: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  lumaStats: PlateLumaStatsSchema.optional(),
  /** Furniture plates only (e.g. "sofa") — where, as a fraction of the
   *  plate's OWN cover-fit-to-canvas height, a genuinely seated subject's
   *  bbox bottom should land: from the seat cushion's top surface down
   *  through the front edge/floor line. Measured once by hand against the
   *  checked-in plate image (see buildTemplateAssets.ts) — the geometric
   *  half of shotQC.ts's "genuinely seated" check (the other half is
   *  semantic: does the sofa visibly occlude the thighs). Absent for a
   *  plate with no furniture to be seated on/against. */
  seatBandFrac: z.object({ top: z.number().min(0).max(1), bottom: z.number().min(0).max(1) }).optional(),
});

/**
 * A format's checked-in template plates (formats/assets/<formatId>/) plus
 * the reference reel's own measured framing constants — built once by
 * authoring/buildTemplateAssets.ts and committed, not generated per job.
 * backgroundReplace.ts (Phase 2) and generation/modelShots.ts (Phase 3)
 * composite the user's own matted footage/photos onto these; gates.ts
 * (Phase 7) checks a composited export's luma distribution against
 * `talkingHead`/`endCard` here instead of hand-picked constants.
 */
export const PlatesManifestSchema = z.object({
  formatId: z.string(),
  plates: z.record(z.string(), PlateAssetSchema),
  /** RGBA overlay — everything below the desk's near edge in `office-dark`,
   *  composited LAST (over the subject) so the subject appears to sit
   *  behind the keyboard/notebook, exactly like the reference. */
  deskForeground: z.string(),
  /** Fraction of `office-dark`'s own height where the desk's near edge
   *  sits — the same line `deskForeground`'s alpha ramps up across. */
  deskEdgeFrac: z.number().min(0).max(1),
  /** Measured once from the reference reel itself (see
   *  authoring/buildTemplateAssets.ts) — targets for subjectFit.ts's
   *  auto-framing and gates.ts's luma-distribution gate. */
  reference: z.object({
    talkingHead: z.object({
      headTopFrac: z.number().min(0).max(1),
      headHeightFrac: z.number().min(0).max(1),
      lumaP50: z.number(),
      lumaP95: z.number(),
      /** Reference's own face-region (head-bbox) mean luma, measured the
       *  SAME way relight.ts's measureFaceLuma measures a render — see
       *  solveSubjectRelight's faceMeasured/faceTargetMean doc comment for
       *  why this differs from (and is more useful than) a hand-picked
       *  bright-patch reading. */
      faceLumaMean: z.number(),
      /** Lateral (X-axis) darkening applied to the FLATTENED talking-head
       *  composite so the frame edges fall off toward black the way the
       *  reference's own single-key-light room does — see matte.ts's
       *  applyLateralFalloff. minFactor: RGB multiplier at the frame's own
       *  left/right edges (1 = no darkening). power: curve shape (1 =
       *  linear falloff from center; >1 keeps more of the center
       *  unaffected, falling off faster near the edges). Tuned once
       *  against this job's own reference/render gap, not measured
       *  directly — same category as deskEdgeFrac. */
      edgeFalloff: z.object({ minFactor: z.number().min(0).max(1), power: z.number().positive() }),
      /** Reference's own face-region p97 luma (middle 60% width of the
       *  head bbox, rows 35-85% of the box — excludes hair/forehead and
       *  chin/neck shadow — intersected with the person mask, 97th
       *  percentile). Distinct from faceLumaMean above (a MEAN over the
       *  whole head bbox, hair included): a fixed-rectangle sample that
       *  sweeps in hair/shadow reads far darker than the face actually is
       *  — see generation/officeCompositeQC.ts's measureFaceP97 doc
       *  comment. Used as the directional key's own solve target (2d),
       *  not the whole-subject relight curve's target. */
      faceP97Target: z.number(),
      /** Target ratio of the composited backdrop's own Laplacian-variance
       *  sharpness to the subject's — a plate this much SOFTER than the
       *  subject reads as "behind them," not "pasted on top." The actual
       *  blur sigma applied is solved per job against this job's own
       *  measured subject sharpness (generation/officeCompositeQC.ts's
       *  solvePlateBlurSigma), never a fixed sigma. */
      plateSharpnessRatioMid: z.number().positive(),
      /** Target temporal luma std (grain) on a flat backdrop patch — real
       *  sensor noise flickers frame to frame; a synthesized/still plate
       *  has none until this is added. The noise filter STRENGTH needed
       *  to hit this is solved per plate (solveGrainStrength), not fixed. */
      grainStdTarget: z.number().positive(),
      /** Target R/B channel-mean ratio ("warmth") for the composited
       *  room. The colorbalance SHIFT needed to hit this is solved from
       *  the plate's own measured R/B (solveWarmthShift), not fixed. */
      roomWarmthTarget: z.number().positive(),
      /** A flat, texture-free patch of the office plate (frame fractions)
       *  — away from the subject and desk foreground — used to measure
       *  and solve both grainStdTarget and roomWarmthTarget against. */
      flatBackdropRegion: z.object({
        topFrac: z.number().min(0).max(1),
        bottomFrac: z.number().min(0).max(1),
        leftFrac: z.number().min(0).max(1),
        rightFrac: z.number().min(0).max(1),
      }),
    }),
    endCard: z.object({
      subjectTopFrac: z.number().min(0).max(1),
      subjectHeightFrac: z.number().min(0).max(1),
      lumaP50: z.number(),
      lumaP95: z.number(),
    }),
  }),
  /** Where a clean instrumental excerpt of the reference's own music sits
   *  within the checked-in music bed file — see musicBed doc comment. */
  musicBed: z
    .object({
      file: z.string(),
      durationSec: z.number().positive(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Inserts — the `generate` stage's own artifact (artifacts/<job>/inserts.json)
// ---------------------------------------------------------------------------

export const GeneratedInsertSchema = z.object({
  slotName: z.string(),
  blockId: z.string(),
  kind: z.enum(["cutaway", "montage", "plateStill", "detailStill", "montageReel", "triptych", "generatedScene"]),
  shot: z.string(),
  durationSec: z.number().positive(),
  seed: z.number().int(),
  provider: z.string(),
  /** True when a prior run's output for the same request hash was reused
   *  instead of calling the provider again. */
  cacheHit: z.boolean(),
  /** Job-dir-relative path to the generated MP4 (same convention as
   *  BoundFile.path), e.g. "generated/montage-clip.mp4". */
  path: z.string(),
  /** Probed from the generated file — carried here (not just in filled.json)
   *  so a later stage can reconstruct the BoundFile from inserts.json alone,
   *  without re-probing or re-running generation (see generate.ts's
   *  applyInserts). filled.json itself always stays pure intake output;
   *  this artifact is the only persisted record of a generated binding. */
  width: z.number().optional(),
  height: z.number().optional(),
  hasAudio: z.boolean().optional(),
  /** generatedScene only (see generatedShots.ts's retry ladder): how this
   *  shot shipped. "green" = cleared every hard AND soft gate. "orange" =
   *  cleared every hard gate but shipped on aesthetic bands, needs a human
   *  look before render. "red" = a hard gate never cleared through the
   *  full ladder, so this shipped from the composite-v2 fallback tier
   *  instead (loud diagnostic elsewhere) — the image is real (the user's
   *  own pixels), just not AI-generated as requested. Absent for
   *  non-generatedScene kinds. */
  flag: z.enum(["green", "orange", "red"]).optional(),
  /** Free-form QC measurements for this shot (generation/shotQC.ts +
   *  faceCheck.ts's output) — kept loosely typed here rather than a rigid
   *  nested schema since the measurement set is still being tuned; the
   *  contact sheet and gates.ts read specific keys out of it by name. */
  qc: z.record(z.string(), z.unknown()).optional(),
});

export const InsertsSchema = z.object({
  inserts: z.array(GeneratedInsertSchema),
  /** Slots that declared `generation` but were left as the user's own
   *  supplied footage instead (an opt-out — see SlotSchema's doc comment). */
  skipped: z.array(z.object({ slotName: z.string(), blockId: z.string() })).default([]),
});

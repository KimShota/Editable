import { z } from "zod";
import { FormatSchema, WordSchema } from "../pipeline/schemas";

/**
 * Contracts for the format-authoring pipeline — the analog of
 * pipeline/schemas.ts, but for reverse-engineering a reference reel into a
 * draft Format instead of assembling a user's own video.
 *
 *   ingest    (URL → local reference clip)                  source.mp4
 *   analyze   (clip → transcript + shots + sampled frames)   analysis.json
 *   synthesize (analysis → draft format, LLM)                draft.json
 *
 * Nesting FormatSchema inside DraftSchema means parsing a Draft also runs
 * FormatSchema's own `.superRefine` cross-reference checks (event → anchor
 * ids, window → literal-anchor refs) on `draft.format` — the same
 * validation loadFormat() runs on a real formats/<id>.json.
 */

export const IngestResultSchema = z.object({
  draftId: z.string(),
  sourcePath: z.string(),
  sourceUrl: z.string(),
  durationSec: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const ShotSchema = z.object({
  index: z.number().int().min(0),
  startSec: z.number().min(0),
  endSec: z.number().positive(),
  /** authoringDir(draftId)-relative path to a sampled representative frame
   *  (the shot's midpoint), e.g. "frames/frame_003.jpg". */
  frame: z.string(),
});

export const DenseFrameSchema = z.object({
  atSec: z.number().min(0),
  /** authoringDir(draftId)-relative path, e.g. "frames/dense_003.jpg". */
  frame: z.string(),
});

export const AnalysisSchema = z.object({
  sourceUrl: z.string(),
  durationSec: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Word-level transcript, seconds relative to the reference clip start. */
  words: z.array(WordSchema),
  /** Scene-change-detected shot boundaries with one sampled frame each. */
  shots: z.array(ShotSchema),
  /** Denser visual sampling than one-frame-per-shot — catches choreography
   *  that happens WITHIN a single shot (overlay pop-ins, blur->reveal,
   *  label recolors), which a continuous-take reel's sparse shot list can't
   *  see at all. See analyze.ts's doc comment for how these are chosen. */
  denseFrames: z.array(DenseFrameSchema),
});

export const VerifyBlockResultSchema = z.object({
  blockId: z.string(),
  /** Mean structural similarity (0-1) between the self-verified render and
   *  the reference over this block's own span. Absent when the block
   *  couldn't be measured at all — see `skipped`. */
  ssim: z.number().optional(),
  /** Why this block wasn't self-verified (e.g. no matching anchor found in
   *  the reference, or it's a broll block — see verify.ts's doc comment
   *  for the current v1 scope). Absent when `ssim` is present. */
  skipped: z.string().optional(),
});

/**
 * Structural similarity over just ONE overlay event's own enter/exit
 * animation window — as opposed to VerifyBlockResult.ssim, which averages
 * over the block's WHOLE span. A short animation (a handful of frames) is
 * a small fraction of a block's total duration, so a wrong or missing
 * entrance barely moves the block-level average; measuring the window on
 * its own is what actually lets a bad animation show up as a bad number,
 * per this format's own MotionSpec (schemas.ts) — see verify.ts's own doc
 * comment on why this exists. Only ever populated for an event that
 * authors `motion` at all; a format with no motion authored gets an empty
 * `windows` array, same as today.
 */
export const VerifyWindowResultSchema = z.object({
  eventId: z.string(),
  blockId: z.string(),
  phase: z.enum(["enter", "exit"]),
  ssim: z.number().optional(),
  skipped: z.string().optional(),
});

export const VerifyResultSchema = z.object({
  draftId: z.string(),
  createdAt: z.string(),
  /** MINIMUM ssim across every measured (non-skipped) block — deliberately
   *  the min, not the mean, so one badly-placed card can't be averaged
   *  away by several accurate ones. Absent when nothing could be measured. */
  overallScore: z.number().optional(),
  blocks: z.array(VerifyBlockResultSchema),
  /** See VerifyWindowResultSchema. */
  windows: z.array(VerifyWindowResultSchema).default([]),
  diagnostics: z.array(z.string()),
});

export const DraftSchema = z.object({
  draftId: z.string(),
  sourceUrl: z.string(),
  createdAt: z.string(),
  /** Plain-English explanation of the structure the model detected —
   *  shown to the reviewer alongside the draft, not consumed by the engine. */
  rationale: z.string(),
  /** The draft format itself — already validated against FormatSchema
   *  (including its cross-reference refinements) by the time this is
   *  written to disk; see synthesize.ts's generate→validate→repair loop. */
  format: FormatSchema,
});

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

export const AnalysisSchema = z.object({
  sourceUrl: z.string(),
  durationSec: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Word-level transcript, seconds relative to the reference clip start. */
  words: z.array(WordSchema),
  /** Scene-change-detected shot boundaries with one sampled frame each. */
  shots: z.array(ShotSchema),
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

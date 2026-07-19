import { z } from "zod";
import {
  AnchoredTimeSchema,
  AnchorSchema,
  AnchorWindowSchema,
  BlockSchema,
  BlockTranscriptSchema,
  BlockTrimSchema,
  BoundAssetSchema,
  ComponentRefSchema,
  EdlCaptionGroupSchema,
  EdlCaptionWordSchema,
  EdlOverlaySchema,
  EdlSchema,
  EdlSfxSchema,
  EdlTransitionSchema,
  EdlVideoSegmentSchema,
  FilledFormatSchema,
  FormatEventSchema,
  FormatSchema,
  JobManifestSchema,
  LiteralAnchorSchema,
  MediaTypeSchema,
  OverridesSchema,
  ResolvedRoleSchema,
  ResolvedRolesSchema,
  SemanticAnchorSchema,
  SlotSchema,
  TranscriptSchema,
  TrimPointsSchema,
  WordSchema,
} from "./schemas";

/**
 * The Phase 0 data model, inferred from the zod schemas in schemas.ts
 * (which are the single source of truth). Every pipeline stage consumes
 * and produces these types and nothing else.
 */

export type ComponentRef = z.infer<typeof ComponentRefSchema>;
export type AnchoredTime = z.infer<typeof AnchoredTimeSchema>;
export type AnchorWindow = z.infer<typeof AnchorWindowSchema>;
export type LiteralAnchor = z.infer<typeof LiteralAnchorSchema>;
export type SemanticAnchor = z.infer<typeof SemanticAnchorSchema>;
export type Anchor = z.infer<typeof AnchorSchema>;
export type MediaType = z.infer<typeof MediaTypeSchema>;
export type Slot = z.infer<typeof SlotSchema>;
export type FormatEvent = z.infer<typeof FormatEventSchema>;
export type Block = z.infer<typeof BlockSchema>;
export type Format = z.infer<typeof FormatSchema>;

export type JobManifest = z.infer<typeof JobManifestSchema>;
export type Overrides = z.infer<typeof OverridesSchema>;
export type BoundAsset = z.infer<typeof BoundAssetSchema>;
export type FilledFormat = z.infer<typeof FilledFormatSchema>;

export type Word = z.infer<typeof WordSchema>;
export type BlockTranscript = z.infer<typeof BlockTranscriptSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;

export type BlockTrim = z.infer<typeof BlockTrimSchema>;
export type TrimPoints = z.infer<typeof TrimPointsSchema>;

export type ResolvedRole = z.infer<typeof ResolvedRoleSchema>;
export type ResolvedRoles = z.infer<typeof ResolvedRolesSchema>;

export type EdlVideoSegment = z.infer<typeof EdlVideoSegmentSchema>;
export type EdlOverlay = z.infer<typeof EdlOverlaySchema>;
export type EdlSfx = z.infer<typeof EdlSfxSchema>;
export type EdlCaptionWord = z.infer<typeof EdlCaptionWordSchema>;
export type EdlCaptionGroup = z.infer<typeof EdlCaptionGroupSchema>;
export type EdlTransition = z.infer<typeof EdlTransitionSchema>;
export type Edl = z.infer<typeof EdlSchema>;

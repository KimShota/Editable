import { z } from "zod";
import {
  AnchoredTimeSchema,
  AnchorSchema,
  AnchorWindowSchema,
  BBoxFracSchema,
  BlockSchema,
  BlockTranscriptSchema,
  BlockTrimSchema,
  BoundAssetSchema,
  BoundFileSchema,
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
  GeneratedInsertSchema,
  GenerationSpecSchema,
  InsertsSchema,
  JobManifestSchema,
  LiteralAnchorSchema,
  MatteArtifactSchema,
  MatteBlockSchema,
  MediaTypeSchema,
  OverridesSchema,
  PlateAssetSchema,
  PlateLumaStatsSchema,
  PlatesManifestSchema,
  PoseTagSchema,
  ResolvedRoleSchema,
  ResolvedRolesSchema,
  SemanticAnchorSchema,
  SlotSchema,
  StyleProfileSchema,
  SubShotSpecSchema,
  TakeTrimSchema,
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
export type PoseTag = z.infer<typeof PoseTagSchema>;
export type SubShotSpec = z.infer<typeof SubShotSpecSchema>;
export type GenerationSpec = z.infer<typeof GenerationSpecSchema>;
export type Slot = z.infer<typeof SlotSchema>;
export type FormatEvent = z.infer<typeof FormatEventSchema>;
export type Block = z.infer<typeof BlockSchema>;
export type Format = z.infer<typeof FormatSchema>;

export type JobManifest = z.infer<typeof JobManifestSchema>;
export type Overrides = z.infer<typeof OverridesSchema>;
export type BoundFile = z.infer<typeof BoundFileSchema>;
export type BoundAsset = z.infer<typeof BoundAssetSchema>;
export type FilledFormat = z.infer<typeof FilledFormatSchema>;

export type Word = z.infer<typeof WordSchema>;
export type BlockTranscript = z.infer<typeof BlockTranscriptSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;

export type TakeTrim = z.infer<typeof TakeTrimSchema>;
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

export type StyleProfile = z.infer<typeof StyleProfileSchema>;

export type PlateLumaStats = z.infer<typeof PlateLumaStatsSchema>;
export type PlateAsset = z.infer<typeof PlateAssetSchema>;
export type PlatesManifest = z.infer<typeof PlatesManifestSchema>;

export type GeneratedInsert = z.infer<typeof GeneratedInsertSchema>;
export type Inserts = z.infer<typeof InsertsSchema>;

export type BBoxFrac = z.infer<typeof BBoxFracSchema>;
export type MatteBlock = z.infer<typeof MatteBlockSchema>;
export type MatteArtifact = z.infer<typeof MatteArtifactSchema>;

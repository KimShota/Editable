import { z } from "zod";
import {
  AnalysisSchema,
  DenseFrameSchema,
  DraftSchema,
  IngestResultSchema,
  ShotSchema,
  VerifyBlockResultSchema,
  VerifyResultSchema,
  VerifyWindowResultSchema,
} from "./schemas";

export type IngestResult = z.infer<typeof IngestResultSchema>;
export type Shot = z.infer<typeof ShotSchema>;
export type DenseFrame = z.infer<typeof DenseFrameSchema>;
export type Analysis = z.infer<typeof AnalysisSchema>;
export type Draft = z.infer<typeof DraftSchema>;
export type VerifyBlockResult = z.infer<typeof VerifyBlockResultSchema>;
export type VerifyWindowResult = z.infer<typeof VerifyWindowResultSchema>;
export type VerifyResult = z.infer<typeof VerifyResultSchema>;

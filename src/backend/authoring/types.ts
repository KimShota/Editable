import { z } from "zod";
import { AnalysisSchema, DraftSchema, IngestResultSchema, ShotSchema } from "./schemas";

export type IngestResult = z.infer<typeof IngestResultSchema>;
export type Shot = z.infer<typeof ShotSchema>;
export type Analysis = z.infer<typeof AnalysisSchema>;
export type Draft = z.infer<typeof DraftSchema>;

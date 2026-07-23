import { z } from "zod";
import { HookFeedbackResultSchema, HookFeedbackSchema, ScriptLineSchema, ScriptSuggestionSchema } from "./schemas";

export type ScriptLine = z.infer<typeof ScriptLineSchema>;
export type ScriptSuggestion = z.infer<typeof ScriptSuggestionSchema>;
export type HookFeedback = z.infer<typeof HookFeedbackSchema>;
export type HookFeedbackResult = z.infer<typeof HookFeedbackResultSchema>;

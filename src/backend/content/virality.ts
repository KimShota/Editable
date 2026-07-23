import { Format } from "../pipeline/types";
import { HookFeedbackSchema } from "./schemas";
import { HookFeedback } from "./types";
import { ContentChoice, generateStructured } from "./provider";

/**
 * On-demand critique of a video's hook — the single highest-leverage
 * moment, and the one place fast feedback is actually actionable before
 * the rest of a video gets filmed.
 */

const buildFeedbackPrompt = (format: Format, hookTitle: string, hookText: string): string =>
  `You are a short-form video coach. This is the HOOK — the opening line — of a video in the format "${format.name}" (${format.description}). The hook block is titled "${hookTitle}".

The hook as delivered:
"${hookText}"

Critique it like a short-form video expert would: does it stop the scroll in the first second? Is the stakes/curiosity clear? Is it generic or does it feel specific and surprising? Then propose 2-3 stronger alternative lines that keep the same topic/meaning but hit harder.

Return a JSON object: {"score": <integer 1-10>, "critique": "<2-4 sentences, direct and specific>", "alternatives": ["<line>", ...]}. Respond with ONLY the JSON object, no other text.`;

export const getHookFeedback = (
  format: Format,
  hookTitle: string,
  hookText: string,
  choice: ContentChoice = "auto",
): Promise<HookFeedback> => generateStructured(buildFeedbackPrompt(format, hookTitle, hookText), HookFeedbackSchema, choice);

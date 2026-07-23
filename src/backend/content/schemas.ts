import { z } from "zod";

/**
 * Contracts for on-demand AI creative help (script suggestions, hook
 * feedback) — a third backend concern alongside `pipeline/` (assemble a
 * user's own footage) and `authoring/` (reverse-engineer a format).
 * Unlike either of those, neither output here has cross-reference
 * constraints (no ids referencing sibling ids), so a single generate +
 * validate + one-retry pass is enough — no repair loop needed.
 */

export const ScriptLineSchema = z.object({
  blockId: z.string(),
  slotName: z.string(),
  /** For a voice-block's main clip: the full line to say, opening with the
   *  block's literal anchor phrase verbatim so anchor-matching still finds
   *  it. For a text slot: the short text itself. */
  text: z.string(),
});

export const ScriptSuggestionSchema = z.object({
  topic: z.string(),
  createdAt: z.string(),
  suggestions: z.array(ScriptLineSchema),
});

export const HookFeedbackSchema = z.object({
  /** 1 (weak) .. 10 (excellent). */
  score: z.number().min(1).max(10),
  critique: z.string(),
  alternatives: z.array(z.string()),
});

export const HookFeedbackResultSchema = HookFeedbackSchema.extend({
  createdAt: z.string(),
  /** The text actually critiqued — a filmed clip's real transcript, or a
   *  script.json suggestion used as a stand-in before filming. */
  hookText: z.string(),
  source: z.enum(["filmed", "suggested"]),
});

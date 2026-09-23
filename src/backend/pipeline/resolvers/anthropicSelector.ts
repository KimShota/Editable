import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  buildSelectionPrompt,
  SelectionQuery,
  SelectionResolver,
  SelectionsSchema,
  SelectionVerdict,
} from "./selectionProtocol";

/**
 * Retake/false-start selection via the Anthropic API (used when
 * ANTHROPIC_API_KEY is set). Structured outputs guarantee the response
 * parses against SelectionsSchema. Mirrors anthropicCorrector.ts.
 */

const DEFAULT_MODEL = "claude-opus-4-8";

export const anthropicSelector = (): SelectionResolver => {
  const client = new Anthropic();
  // `||` (not `??`) deliberately — an EDITABLE_LLM_MODEL="" in .env is "not
  // set", not "use an empty model string" (which the API rejects outright).
  const model = process.env.EDITABLE_LLM_MODEL || DEFAULT_MODEL;

  return {
    name: `anthropic:${model}`,
    selectBlock: async (input: SelectionQuery): Promise<SelectionVerdict[]> => {
      const response = await client.messages.parse({
        model,
        max_tokens: 4000,
        thinking: { type: "adaptive" },
        messages: [{ role: "user", content: buildSelectionPrompt(input) }],
        output_config: { format: zodOutputFormat(SelectionsSchema) },
      });
      if (!response.parsed_output) {
        throw new Error("anthropic selector: response did not match schema");
      }
      return response.parsed_output.verdicts;
    },
  };
};

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  buildCorrectionPrompt,
  CorrectionQuery,
  CorrectionsSchema,
  TranscriptCorrector,
  WordCorrection,
} from "./correctionProtocol";

/**
 * Transcript correction via the Anthropic API (used when ANTHROPIC_API_KEY
 * is set). Structured outputs guarantee the response parses against
 * CorrectionsSchema.
 */

const DEFAULT_MODEL = "claude-opus-4-8";

export const anthropicCorrector = (): TranscriptCorrector => {
  const client = new Anthropic();
  const model = process.env.EDITABLE_LLM_MODEL ?? DEFAULT_MODEL;

  return {
    name: `anthropic:${model}`,
    correctBlock: async (input: CorrectionQuery): Promise<WordCorrection[]> => {
      const response = await client.messages.parse({
        model,
        max_tokens: 4000,
        thinking: { type: "adaptive" },
        messages: [{ role: "user", content: buildCorrectionPrompt(input) }],
        output_config: { format: zodOutputFormat(CorrectionsSchema) },
      });
      if (!response.parsed_output) {
        throw new Error("anthropic corrector: response did not match schema");
      }
      return response.parsed_output.corrections;
    },
  };
};

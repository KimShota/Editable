import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  buildPrompt,
  ResolutionsSchema,
  ResolveBlockInput,
  RoleResolution,
  RoleResolver,
} from "./protocol";

/**
 * Role resolution via the Anthropic API (used when ANTHROPIC_API_KEY is set).
 * Structured outputs guarantee the response parses against ResolutionsSchema.
 */

const DEFAULT_MODEL = "claude-opus-4-8";

export const anthropicResolver = (): RoleResolver => {
  const client = new Anthropic();
  const model = process.env.EDITABLE_LLM_MODEL ?? DEFAULT_MODEL;

  return {
    name: `anthropic:${model}`,
    resolveBlock: async (input: ResolveBlockInput): Promise<RoleResolution[]> => {
      const response = await client.messages.parse({
        model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        messages: [{ role: "user", content: buildPrompt(input) }],
        output_config: { format: zodOutputFormat(ResolutionsSchema) },
      });
      if (!response.parsed_output) {
        throw new Error("anthropic resolver: response did not match schema");
      }
      return response.parsed_output.resolutions;
    },
  };
};

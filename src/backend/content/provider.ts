import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { claudeCliAvailable } from "../pipeline/resolvers/claudeCli";

/**
 * Shared LLM shim for on-demand creative help (script suggestions, hook
 * feedback) — both are "ask for one small JSON object" with no
 * cross-reference constraints (unlike authoring's synthesize.ts, which
 * needs a real generate→validate→repair loop because FormatSchema's
 * superRefine can't be guaranteed structurally), so a single retry on a
 * validation failure is enough here.
 */

export type ContentChoice = "anthropic" | "claude-cli" | "auto";

const DEFAULT_MODEL = "claude-opus-4-8";
const CLAUDE_CLI_TIMEOUT_MS = 120_000;

const extractJsonObject = (text: string): unknown => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`no JSON object found in model output: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
};

const viaAnthropic = async <T>(prompt: string, schema: z.ZodType<T>): Promise<T> => {
  const client = new Anthropic();
  // `||` (not `??`) deliberately — an EDITABLE_LLM_MODEL="" in .env is "not
  // set", not "use an empty model string" (which the API rejects outright).
  const model = process.env.EDITABLE_LLM_MODEL || DEFAULT_MODEL;
  const response = await client.messages.parse({
    model,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: prompt }],
    output_config: { format: zodOutputFormat(schema) },
  });
  if (!response.parsed_output) {
    throw new Error("anthropic: response did not match the expected schema");
  }
  return response.parsed_output;
};

const viaClaudeCli = <T>(prompt: string, schema: z.ZodType<T>): T => {
  const out = execFileSync("claude", ["-p"], {
    input: prompt,
    encoding: "utf8",
    timeout: CLAUDE_CLI_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  return schema.parse(extractJsonObject(out));
};

/**
 * Runs one prompt against whichever content provider is available/chosen,
 * validates the response against `schema`, and retries once (with the
 * validation error fed back) on failure. No silent non-LLM fallback —
 * unlike role resolution or transcript correction, there's no sensible
 * placeholder for "a script" or "hook feedback"; if neither provider is
 * available, this throws.
 */
export const generateStructured = async <T>(
  prompt: string,
  schema: z.ZodType<T>,
  choice: ContentChoice = "auto",
): Promise<T> => {
  if (choice === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("generateStructured: 'anthropic' requires ANTHROPIC_API_KEY (put it in .env)");
  }
  if (choice === "claude-cli" && !claudeCliAvailable()) {
    throw new Error("generateStructured: 'claude-cli' requires the `claude` CLI on PATH");
  }

  const useAnthropic = choice === "anthropic" || (choice === "auto" && !!process.env.ANTHROPIC_API_KEY);
  const useClaudeCli = !useAnthropic && (choice === "claude-cli" || (choice === "auto" && claudeCliAvailable()));
  if (!useAnthropic && !useClaudeCli) {
    throw new Error(
      "generateStructured: no ANTHROPIC_API_KEY and no claude CLI on PATH — AI creative help needs one of these",
    );
  }

  const attempt = (p: string): Promise<T> => (useAnthropic ? viaAnthropic(p, schema) : Promise.resolve(viaClaudeCli(p, schema)));

  try {
    return await attempt(prompt);
  } catch (err) {
    const repairPrompt = `${prompt}\n\nYour previous response failed validation:\n${(err as Error).message}\n\nRespond again with ONLY the corrected JSON object, no other text.`;
    return attempt(repairPrompt);
  }
};

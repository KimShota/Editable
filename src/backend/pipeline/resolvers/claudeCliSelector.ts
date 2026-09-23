import { execFileSync } from "node:child_process";
import {
  buildSelectionPrompt,
  SelectionQuery,
  SelectionResolver,
  SelectionsSchema,
  SelectionVerdict,
} from "./selectionProtocol";

/**
 * Retake/false-start selection via the local `claude` CLI (Claude Code
 * headless mode). Needs no API key — reuses the user's existing Claude
 * Code login. Mirrors claudeCliCorrector.ts.
 */

const TIMEOUT_MS = 120_000;

/** Pull the first {...} JSON object out of possibly-chatty CLI output. */
const extractJson = (text: string): unknown => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`no JSON object in output: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
};

export const claudeCliSelector = (): SelectionResolver => ({
  name: "claude-cli",
  selectBlock: async (input: SelectionQuery): Promise<SelectionVerdict[]> => {
    const prompt = buildSelectionPrompt(input);
    const attempt = (): SelectionVerdict[] => {
      const out = execFileSync("claude", ["-p"], {
        input: prompt,
        encoding: "utf8",
        timeout: TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
      return SelectionsSchema.parse(extractJson(out)).verdicts;
    };
    try {
      return attempt();
    } catch (err) {
      console.warn(
        `claude-cli selector: first attempt failed (${(err as Error).message}), retrying once`,
      );
      return attempt();
    }
  },
});

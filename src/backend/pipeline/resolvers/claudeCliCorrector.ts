import { execFileSync } from "node:child_process";
import {
  buildCorrectionPrompt,
  CorrectionQuery,
  CorrectionsSchema,
  TranscriptCorrector,
  WordCorrection,
} from "./correctionProtocol";

/**
 * Transcript correction via the local `claude` CLI (Claude Code headless
 * mode). Needs no API key — reuses the user's existing Claude Code login.
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

export const claudeCliCorrector = (): TranscriptCorrector => ({
  name: "claude-cli",
  correctBlock: async (input: CorrectionQuery): Promise<WordCorrection[]> => {
    const prompt = buildCorrectionPrompt(input);
    const attempt = (): WordCorrection[] => {
      const out = execFileSync("claude", ["-p"], {
        input: prompt,
        encoding: "utf8",
        timeout: TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
      return CorrectionsSchema.parse(extractJson(out)).corrections;
    };
    try {
      return attempt();
    } catch (err) {
      console.warn(
        `claude-cli corrector: first attempt failed (${(err as Error).message}), retrying once`,
      );
      return attempt();
    }
  },
});

import { execFileSync } from "node:child_process";
import {
  buildPrompt,
  ResolutionsSchema,
  ResolveBlockInput,
  RoleResolution,
  RoleResolver,
} from "./protocol";

/**
 * Role resolution via the local `claude` CLI (Claude Code headless mode).
 * Needs no API key — it uses the user's existing Claude Code login. Slower
 * than the API but lets the whole pipeline run with zero configuration.
 */

const TIMEOUT_MS = 180_000;

/** Pull the first {...} JSON object out of possibly-chatty CLI output. */
const extractJson = (text: string): unknown => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`no JSON object in output: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
};

export const claudeCliAvailable = (): boolean => {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
};

export const claudeCliResolver = (): RoleResolver => ({
  name: "claude-cli",
  resolveBlock: async (input: ResolveBlockInput): Promise<RoleResolution[]> => {
    const prompt = buildPrompt(input);
    const attempt = (): RoleResolution[] => {
      const out = execFileSync("claude", ["-p"], {
        input: prompt,
        encoding: "utf8",
        timeout: TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
      return ResolutionsSchema.parse(extractJson(out)).resolutions;
    };
    try {
      return attempt();
    } catch (err) {
      console.warn(
        `claude-cli resolver: first attempt failed (${(err as Error).message}), retrying once`,
      );
      return attempt();
    }
  },
});

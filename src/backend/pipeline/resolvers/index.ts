import { RoleResolver } from "./protocol";
import { anthropicResolver } from "./anthropic";
import { claudeCliAvailable, claudeCliResolver } from "./claudeCli";
import { TranscriptCorrector } from "./correctionProtocol";
import { anthropicCorrector } from "./anthropicCorrector";
import { claudeCliCorrector } from "./claudeCliCorrector";

export type ResolverChoice = "anthropic" | "claude-cli" | "fallback" | "auto";

/**
 * Pick the role-resolution provider. Returns null for fallback-only mode
 * (no LLM; every role uses its config fallback position), which keeps the
 * pipeline runnable with zero external dependencies.
 *
 * auto order: ANTHROPIC_API_KEY → claude CLI → fallback-only.
 */
export const pickResolver = (choice: ResolverChoice = "auto"): RoleResolver | null => {
  switch (choice) {
    case "anthropic":
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error("resolver 'anthropic' requires ANTHROPIC_API_KEY (put it in .env)");
      }
      return anthropicResolver();
    case "claude-cli":
      if (!claudeCliAvailable()) {
        throw new Error("resolver 'claude-cli' requires the `claude` CLI on PATH");
      }
      return claudeCliResolver();
    case "fallback":
      return null;
    case "auto":
      if (process.env.ANTHROPIC_API_KEY) return anthropicResolver();
      if (claudeCliAvailable()) return claudeCliResolver();
      console.warn(
        "resolveRoles: no ANTHROPIC_API_KEY and no claude CLI — using fallback positions only",
      );
      return null;
  }
};

/**
 * Pick the transcript-correction provider. Same provider precedence as
 * pickResolver (they're independent concerns — a job could in principle use
 * different choices for each — but sharing the choice keeps the CLI/API
 * surface simple). Returns null for "fallback"/"auto"-with-nothing-available,
 * which skips correction entirely (the raw whisper transcript is used as-is).
 */
export const pickCorrector = (choice: ResolverChoice = "auto"): TranscriptCorrector | null => {
  switch (choice) {
    case "anthropic":
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error("resolver 'anthropic' requires ANTHROPIC_API_KEY (put it in .env)");
      }
      return anthropicCorrector();
    case "claude-cli":
      if (!claudeCliAvailable()) {
        throw new Error("resolver 'claude-cli' requires the `claude` CLI on PATH");
      }
      return claudeCliCorrector();
    case "fallback":
      return null;
    case "auto":
      if (process.env.ANTHROPIC_API_KEY) return anthropicCorrector();
      if (claudeCliAvailable()) return claudeCliCorrector();
      return null;
  }
};

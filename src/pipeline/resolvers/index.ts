import { RoleResolver } from "./protocol";
import { anthropicResolver } from "./anthropic";
import { claudeCliAvailable, claudeCliResolver } from "./claudeCli";

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

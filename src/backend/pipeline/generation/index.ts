import { GenerationProvider, fallbackGenerationProvider } from "./provider";
import { geminiGenerationProvider } from "./gemini";
import { higgsfieldGenerationProvider } from "./higgsfield";

export type GeneratorChoice = "fallback" | "gemini" | "higgsfield" | "auto";

/**
 * Pick the insert-generation provider. Same precedence shape as
 * resolvers/index.ts's pickResolver: auto prefers a real provider when its
 * keys are present, falling back to the zero-spend stub with a warning
 * otherwise — so the pipeline stays runnable with no external dependency,
 * but upgrades itself automatically the moment credentials exist.
 * Higgsfield takes precedence over Gemini in "auto" since it's the
 * project's primary generation backend; Gemini remains available as an
 * explicit choice (generator: "gemini") or fallback if only its key is set.
 */
export const pickGenerationProvider = (choice: GeneratorChoice = "auto"): GenerationProvider => {
  switch (choice) {
    case "fallback":
      return fallbackGenerationProvider;
    case "gemini":
      if (!process.env.GEMINI_API_KEY) {
        throw new Error("generator 'gemini' requires GEMINI_API_KEY (put it in .env)");
      }
      return geminiGenerationProvider;
    case "higgsfield":
      if (!process.env.HIGGSFIELD_API_KEY || !process.env.HIGGSFIELD_API_SECRET) {
        throw new Error(
          "generator 'higgsfield' requires HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET (put them in .env)",
        );
      }
      return higgsfieldGenerationProvider;
    case "auto":
      if (process.env.HIGGSFIELD_API_KEY && process.env.HIGGSFIELD_API_SECRET) return higgsfieldGenerationProvider;
      if (process.env.GEMINI_API_KEY) return geminiGenerationProvider;
      console.warn(
        "generate: no HIGGSFIELD_API_KEY/HIGGSFIELD_API_SECRET or GEMINI_API_KEY — using fallback (Ken-Burns over an identity photo, no real scene recreation)",
      );
      return fallbackGenerationProvider;
  }
};

export type { GenerationProvider, GenerationRequest } from "./provider";

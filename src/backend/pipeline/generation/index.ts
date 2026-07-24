import { GenerationProvider, fallbackGenerationProvider } from "./provider";

export type GeneratorChoice = "fallback" | "auto";

/**
 * Pick the insert-generation provider. Only "fallback" exists today (see
 * provider.ts) — a real identity-preserving generative backend is a later
 * phase, plugged in here the same way resolvers/index.ts adds providers,
 * without changing generate.ts or anything downstream of it.
 */
export const pickGenerationProvider = (choice: GeneratorChoice = "auto"): GenerationProvider => {
  switch (choice) {
    case "fallback":
    case "auto":
      return fallbackGenerationProvider;
  }
};

export type { GenerationProvider, GenerationRequest } from "./provider";

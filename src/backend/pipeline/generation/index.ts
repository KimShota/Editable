import { GenerationProvider, fallbackGenerationProvider } from "./provider";
import { geminiGenerationProvider } from "./gemini";
import { higgsfieldGenerationProvider } from "./higgsfield";
import { modelShotsGenerationProvider } from "./modelShots";

export type GeneratorChoice = "fallback" | "gemini" | "higgsfield" | "model-shots" | "auto";

/**
 * Pick the insert-generation provider. Same precedence shape as
 * resolvers/index.ts's pickResolver: auto prefers a real provider when its
 * keys are present, falling back to the zero-spend stub with a warning
 * otherwise — so the pipeline stays runnable with no external dependency,
 * but upgrades itself automatically the moment credentials exist.
 *
 * "auto" now prefers modelShots (generation/modelShots.ts) over the old
 * higgsfield/gemini providers: its plateStill tier needs no API key at all
 * (a deterministic composite onto the format's own checked-in plates), and
 * its detailStill/montageReel/triptych tiers call Gemini, not Higgsfield —
 * cheaper per the project's own preference (Higgsfield credits are
 * limited, Gemini is not) and the only provider that actually understands
 * the new plateStill/detailStill/montageReel/triptych generation kinds
 * (see schemas.ts's GenerationSpecSchema). "gemini"/"higgsfield" remain
 * available as explicit choices for a format still using the legacy
 * cutaway/montage kinds.
 */
export const pickGenerationProvider = (choice: GeneratorChoice = "auto"): GenerationProvider => {
  switch (choice) {
    case "fallback":
      return fallbackGenerationProvider;
    case "model-shots":
      return modelShotsGenerationProvider;
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
      return modelShotsGenerationProvider;
  }
};

export type { GenerationProvider, GenerationRequest } from "./provider";

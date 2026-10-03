"use client";

import { createContext, useContext } from "react";

/**
 * Where an AI video's clips came from, so the Takes panel can put the
 * original shot next to the generated one. Provided by /videos/<card>/edit;
 * absent in the old template editor, where ClipTakes shows takes alone.
 */
export type AiVideoSource = {
  /** The original viral video. */
  videoUrl: string;
  /** Each shot's span in it, by shot id (the timeline clip's blockId). */
  shots: Record<string, { startSec: number; endSec: number }>;
};

const AiVideoSourceContext = createContext<AiVideoSource | null>(null);

export const AiVideoSourceProvider = AiVideoSourceContext.Provider;
export const useAiVideoSource = (): AiVideoSource | null => useContext(AiVideoSourceContext);

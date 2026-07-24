import { execFileSync } from "node:child_process";
import { StyleProfile } from "../types";

/**
 * The `generate` stage's provider contract — one generated insert in, one
 * MP4 out. Kept behind this interface so a real generative backend
 * (identity-preserving still generation + image-to-video) can be swapped
 * in later without touching generate.ts or anything downstream: assemble
 * and render see only an ordinary bound video file either way (see
 * schemas.ts's GenerationSpecSchema doc comment).
 */
export type GenerationRequest = {
  /** Absolute paths to the job's identity reference photos. */
  identityImages: string[];
  styleProfile: StyleProfile;
  /** Plain-language shot description from the slot's GenerationSpec. */
  shot: string;
  durationSec: number;
  /** Pinned per-slot so re-running the stage reproduces the same output. */
  seed: number;
  width: number;
  height: number;
  fps: number;
  /** Where the provider must write the resulting MP4. */
  outPath: string;
};

export interface GenerationProvider {
  name: string;
  generate(req: GenerationRequest): Promise<void>;
}

/** How far zoompan pushes in over the clip's full duration — subtle, not a
 *  Ken-Burns cliche, since the point is to not distract from the montage. */
const ZOOM_PER_FRAME = 0.0008;
const MAX_ZOOM = 1.25;

/** Maps a StyleProfile grade's -1..1 temperatureShift onto colorbalance's
 *  red/blue channel shifts. */
const colorBalanceArgs = (temperatureShift: number): string => {
  const shadow = temperatureShift * 0.3;
  const mid = temperatureShift * 0.3;
  const high = temperatureShift * 0.2;
  return `colorbalance=rs=${shadow.toFixed(3)}:bs=${(-shadow).toFixed(3)}:rm=${mid.toFixed(3)}:bm=${(-mid).toFixed(3)}:rh=${high.toFixed(3)}:bh=${(-high).toFixed(3)}`;
};

/**
 * Zero-spend, zero-GPU stand-in for real generation: a slow push-in over
 * one of the job's own identity photos, with the format's StyleProfile
 * grade applied via ffmpeg. Doesn't synthesize a new environment — it
 * exists to prove the `generate` stage's contract (a generated slot ends
 * up bound to a real MP4 that flows through the unchanged engine) with no
 * external dependency, exactly as the "fallback" role/content resolvers
 * let the rest of the pipeline run with no LLM. Swap in a real provider
 * (see this file's GenerationProvider interface) without touching
 * generate.ts or anything downstream.
 */
export const fallbackGenerationProvider: GenerationProvider = {
  name: "fallback",
  generate: async (req) => {
    if (req.identityImages.length === 0) {
      throw new Error("fallback generation provider: no identity images to draw from");
    }
    // Seed picks which reference photo to use — the only thing "seed" can
    // meaningfully vary without a real generative model, but it does mean
    // several generated slots in one job show different angles rather than
    // all reusing the same photo.
    const image = req.identityImages[req.seed % req.identityImages.length];
    const frames = Math.max(1, Math.round(req.durationSec * req.fps));
    const grade = req.styleProfile.grade;

    const filters = [
      // Cover-fit the photo to the target frame, then oversample 2x so
      // zoompan has room to push in without visibly softening/pixelating.
      `scale=${req.width * 2}:${req.height * 2}:force_original_aspect_ratio=increase`,
      `crop=${req.width * 2}:${req.height * 2}`,
      `zoompan=z='min(zoom+${ZOOM_PER_FRAME},${MAX_ZOOM})':d=${frames}:s=${req.width}x${req.height}:fps=${req.fps}`,
      `eq=brightness=${(grade?.brightness ?? 0).toFixed(3)}:contrast=${(grade?.contrast ?? 1).toFixed(3)}:saturation=${(grade?.saturation ?? 1).toFixed(3)}`,
      colorBalanceArgs(grade?.temperatureShift ?? 0),
      "format=yuv420p",
    ].join(",");

    try {
      execFileSync(
        "ffmpeg",
        [
          "-y",
          "-v",
          "error",
          "-loop",
          "1",
          "-i",
          image,
          "-frames:v",
          String(frames),
          "-vf",
          filters,
          "-r",
          String(req.fps),
          req.outPath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? (err as Error).message;
      throw new Error(`fallback generation provider: ffmpeg failed for "${req.outPath}":\n${stderr.slice(-2000)}`);
    }
  },
};

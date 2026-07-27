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
  /** cutaway | montage — see schemas.ts's GenerationSpecSchema. A provider
   *  compositing a real subject onto a synthesized backdrop (rather than
   *  asking a model to invent one) can use this for framing decisions,
   *  e.g. crushing a montage toward silhouette. */
  kind: "cutaway" | "montage";
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

/**
 * Turns one still image into a `durationSec`-long clip: a slow Ken-Burns
 * push-in, no grading — the format's StyleProfile grade is applied exactly
 * once, uniformly across every segment (generated stills and real footage
 * alike), by EdlVideo's own CSS filter (see schemas.ts's GradeSchema doc
 * comment). Baking it in here too would double it up. Shared by every
 * provider that ends up needing to animate a still — the fallback stub
 * (over an unmodified identity photo) and any real provider (over its own
 * generated/composited still) alike — so the "turn a still into a moving
 * clip" mechanics exist exactly once.
 */
export const animateStillToClip = (
  imagePath: string,
  opts: {
    durationSec: number;
    width: number;
    height: number;
    fps: number;
    outPath: string;
  },
): void => {
  const frames = Math.max(1, Math.round(opts.durationSec * opts.fps));

  const filters = [
    // Cover-fit the image to the target frame, then oversample 2x so
    // zoompan has room to push in without visibly softening/pixelating.
    `scale=${opts.width * 2}:${opts.height * 2}:force_original_aspect_ratio=increase`,
    `crop=${opts.width * 2}:${opts.height * 2}`,
    `zoompan=z='min(zoom+${ZOOM_PER_FRAME},${MAX_ZOOM})':d=${frames}:s=${opts.width}x${opts.height}:fps=${opts.fps}`,
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
        imagePath,
        "-frames:v",
        String(frames),
        "-vf",
        filters,
        "-r",
        String(opts.fps),
        opts.outPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? (err as Error).message;
    throw new Error(`animateStillToClip: ffmpeg failed for "${opts.outPath}":\n${stderr.slice(-2000)}`);
  }
};

/**
 * Zero-spend, zero-GPU stand-in for real generation: animates one of the
 * job's own identity photos as-is. Doesn't synthesize a new environment —
 * it exists to prove the `generate` stage's contract (a generated slot
 * ends up bound to a real MP4 that flows through the unchanged engine)
 * with no external dependency, exactly as the "fallback" role/content
 * resolvers let the rest of the pipeline run with no LLM. Swap in a real
 * provider (see this file's GenerationProvider interface) without
 * touching generate.ts or anything downstream.
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
    animateStillToClip(image, {
      durationSec: req.durationSec,
      width: req.width,
      height: req.height,
      fps: req.fps,
      outPath: req.outPath,
    });
  },
};

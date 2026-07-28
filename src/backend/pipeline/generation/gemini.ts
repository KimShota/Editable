import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GenerationProvider, GenerationRequest, animateStillToClip } from "./provider";
import { generateImage } from "./geminiImage";

/**
 * Real generation provider (vs. provider.ts's zero-spend fallback): calls
 * Gemini's image model ("Nano Banana Pro") with the job's identity photos
 * as reference, asking it to recreate the person in the format's
 * StyleProfile environment/lighting — an identity-preserving still. That
 * still is then animated into the slot's durationSec clip via the same
 * Ken-Burns+grade helper the fallback stub uses, so the two providers
 * differ only in WHERE the still comes from (an unmodified photo vs. a
 * generated composite), not in how it becomes a clip.
 *
 * Legacy path (kind "cutaway"/"montage") — cinematic-debut-manifesto now
 * uses generation/modelShots.ts's plateStill/detailStill/montageReel/
 * triptych kinds instead, but this stays as the "gemini" explicit
 * --generator choice and geminiImage.ts's shared HTTP plumbing for any
 * format that still wants a plain identity-recreation still.
 */

const buildPrompt = (req: GenerationRequest): string => {
  const { environment, lighting, grade } = req.styleProfile;
  const gradeNote =
    grade?.temperatureShift !== undefined && grade.temperatureShift < 0
      ? "a cool, desaturated color grade"
      : "a warm color grade";
  return (
    `Photorealistic portrait recreation. The attached reference photo(s) show a specific real person — ` +
    `preserve their exact facial identity, likeness, hairstyle, and clothing unchanged; do not invent a ` +
    `different person. Recreate that same person, in their own clothing, in this pose/shot: ${req.shot}. ` +
    `Environment: ${environment}. Lighting: ${lighting}. Overall look: cinematic, photorealistic, ` +
    `${gradeNote}, high contrast, shallow depth of field, 35mm lens.`
  );
};

export const geminiGenerationProvider: GenerationProvider = {
  name: "gemini",
  generate: async (req) => {
    if (req.identityImages.length === 0) {
      throw new Error("gemini generation provider: no identity images to draw from");
    }

    // Up to 3 reference angles — enough for identity, cheap enough on tokens.
    const bytes = await generateImage(buildPrompt(req), req.identityImages, 3);

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-gemini-"));
    try {
      const stillPath = path.join(workDir, "still.png");
      fs.writeFileSync(stillPath, bytes);
      animateStillToClip(stillPath, {
        durationSec: req.durationSec,
        width: req.width,
        height: req.height,
        fps: req.fps,
        outPath: req.outPath,
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  },
};

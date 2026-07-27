import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GenerationProvider, animateStillToClip } from "./provider";
import { compositeOnBackdrop, generateGradientBackdrop, resizeCover } from "./matte";
import { buildBackdropPrompt, generateBackdropImage } from "./higgsfieldBackdrop";

/**
 * Real generation provider (vs. provider.ts's zero-spend fallback). Two
 * paths, split on `req.kind`:
 *
 * - montage (SILHOUETTE-style): NO external call at all. The backdrop is
 *   a flat, measured light-gray gradient (matte.ts's
 *   generateGradientBackdrop — see its doc comment for the reference
 *   measurements it's built from), and the subject is crushed via the
 *   same file's SILHOUETTE_CRUSH curve. Free, deterministic, and
 *   precisely on-target — there's no specific set to generate for a
 *   silhouette, just a seamless-paper field.
 * - cutaway: calls Higgsfield's Soul text-to-image model for the INSERT'S
 *   BACKDROP ONLY — an empty environment, no person in the prompt or the
 *   request. The job's own identity photo is then composited onto it
 *   locally via matte.ts (macOS Vision person segmentation, no external
 *   call for the subject). The subject in the output is always the
 *   user's real pixels; only the set behind them is ever synthesized.
 *
 * Either way the composited still is animated into the slot's
 * durationSec clip via the same Ken-Burns helper the other providers use.
 *
 * This deliberately replaces an earlier version that asked Soul to
 * "recreate" the person from a reference photo for EVERY insert — an
 * identity-preserving generation model still invents a face; it is not
 * the same face. Asking it to draw an empty room instead (or, for the
 * montage, not asking it anything at all) sidesteps that failure mode.
 */

export const higgsfieldGenerationProvider: GenerationProvider = {
  name: "higgsfield",
  generate: async (req) => {
    if (req.identityImages.length === 0) {
      throw new Error("higgsfield generation provider: no identity images to draw from");
    }

    // Seed picks which reference photo to use, same convention as the
    // fallback provider — several generated slots in one job then draw
    // from different angles rather than all reusing the same photo.
    const subjectPath = req.identityImages[req.seed % req.identityImages.length];

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-higgsfield-"));
    try {
      const backdropPath = path.join(workDir, "backdrop.png");
      let backdropWidth = req.width;
      let backdropHeight = req.height;

      if (req.kind === "montage") {
        generateGradientBackdrop(req.width, req.height, backdropPath);
      } else {
        const prompt = buildBackdropPrompt(req.styleProfile.environment, req.styleProfile.lighting, req.shot);
        const { bytes, size } = await generateBackdropImage(prompt, req.width, req.height);
        fs.writeFileSync(backdropPath, bytes);
        backdropWidth = size.width;
        backdropHeight = size.height;
      }

      // The subject photo comes in at whatever resolution the user shot
      // it — cover-fit it onto the backdrop's exact canvas before matting
      // so the two composite cleanly (alphamerge/overlay require matching
      // sizes).
      const subjectResizedPath = path.join(workDir, "subject.png");
      resizeCover(subjectPath, backdropWidth, backdropHeight, subjectResizedPath);

      const compositePath = path.join(workDir, "composite.png");
      compositeOnBackdrop({
        subjectImagePath: subjectResizedPath,
        backdropPath,
        outPath: compositePath,
        silhouette: req.kind === "montage",
      });

      animateStillToClip(compositePath, {
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

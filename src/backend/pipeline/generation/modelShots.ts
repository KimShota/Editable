import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GenerationProvider, GenerationRequest, animateStillToClip } from "./provider";
import { compositeOnBackdrop, resizeCover } from "./matte";
import { loadPlatesManifest, platePath } from "./plates";
import { measureSubjectBBox, computeSubjectTransform } from "./subjectFit";
import { measureSubjectLuma, solveSubjectRelight } from "./relight";
import { pickByPose } from "./identityPrep";
import { generateImage } from "./geminiImage";
import { PlatesManifest, PoseTag, SubShotSpec } from "../types";

/**
 * The tiered "real model shots" provider (see the Kumar-template-parity
 * plan): three tiers, cheapest/most-identity-faithful first.
 *
 *  1. plateStill — a real identity photo, matted and composited onto one
 *     of the format's checked-in plates (formats/assets/<id>/), fit and
 *     relit the same way backgroundReplace.ts fits the talking-head shots
 *     (subjectFit.ts + relight.ts). Free, deterministic, and the actual
 *     person — not a generative model's guess at their face.
 *  2. detailStill — a Gemini-generated close-up (glasses, hands, shoes —
 *     shots no uploaded photo covers and no plate composite can invent
 *     props for) using the identity photos as likeness reference.
 *  3. montageReel / triptych — composed from several plateStill/
 *     detailStill sub-shots: concatenated into one multi-cut clip, or
 *     stacked into one multi-panel frame.
 *
 * No image-to-video model is called anywhere here — every generated shot
 * is a still (composited or Gemini-drawn) animated with the same
 * Ken-Burns push every other provider uses (provider.ts's
 * animateStillToClip). A subtle push on a held pose reads as intentional
 * at the reference's own 0.6-0.9s cutaway durations; keeping every tier
 * off any per-job video-generation API also means zero incremental
 * Higgsfield spend for a format whose backdrop calls (Phase 2) already
 * dropped to zero.
 */

const workDirFor = (label: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `editable-modelshots-${label}-`));

/** subjectFit/relight target for every plateStill — the reference's own
 *  studio/couch stills are all posed-portrait shots (like the end card),
 *  not talking-head close-ups, so the end-card framing/luma constants are
 *  the right reference for all of them, not just the end card itself. */
const plateStillTarget = (manifest: PlatesManifest) => ({
  topFrac: manifest.reference.endCard.subjectTopFrac,
  heightFrac: manifest.reference.endCard.subjectHeightFrac,
});

/** Composites one identity photo onto one plate, fit/relit to match the
 *  reference's own posed-portrait framing — the plateStill kind's core,
 *  reused (at a smaller per-panel size) by montageReel/triptych's own
 *  plateStill sub-shots. */
const buildPlateStillImage = (
  req: GenerationRequest,
  spec: { plate?: string; treatment?: "lit" | "silhouette"; poseTag?: PoseTag; seed: number },
  width: number,
  height: number,
  outImagePath: string,
): void => {
  if (!spec.plate) throw new Error("modelShots: plateStill sub-shot needs a `plate`");
  const manifest = loadPlatesManifest(req.formatId);
  const treatment = spec.treatment ?? "silhouette";
  const backdropAbs = platePath(req.formatId, manifest, spec.plate);
  const subjectPhoto = pickByPose(req.identityImages, req.identityPoseTags, spec.poseTag, spec.seed);
  const target = plateStillTarget(manifest);

  const workDir = workDirFor("plate");
  try {
    const backdropSized = path.join(workDir, "backdrop.png");
    resizeCover(backdropAbs, width, height, backdropSized);
    const subjectSized = path.join(workDir, "subject.png");
    resizeCover(subjectPhoto, width, height, subjectSized);

    compositeOnBackdrop({
      subjectImagePath: subjectSized,
      backdropPath: backdropSized,
      outPath: outImagePath,
      silhouette: treatment === "silhouette",
      calibrate: (matteInDir, matteOutDir) => {
        const bbox = measureSubjectBBox(matteOutDir, width, height);
        const subjectTransform = computeSubjectTransform(bbox, target, width, height);
        if (treatment !== "lit") return { subjectTransform };
        const measured = measureSubjectLuma(matteInDir, matteOutDir, 1);
        const subjectFilter = measured
          ? solveSubjectRelight(measured, { p50: manifest.reference.endCard.lumaP50, p95: manifest.reference.endCard.lumaP95 })
          : undefined;
        return { subjectTransform, subjectFilter };
      },
    });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

const detailPrompt = (req: GenerationRequest, shot: string): string => {
  const { environment, lighting } = req.styleProfile;
  return (
    `Photorealistic cinematic close-up detail shot for a personal-brand video. Show: ${shot}. ` +
    `Where a hand, arm, or any body part of the person is visible, match THIS specific person's own skin ` +
    `tone and hands/likeness from the attached reference photos — do not invent a different person's hands. ` +
    `Environment: ${environment}. Lighting: ${lighting}. Cinematic, high detail, shallow depth of field, ` +
    `moody chiaroscuro, 35mm lens.`
  );
};

/** Gemini-generated close-up, sized to the target panel/canvas. Falls back
 *  to a plain identity-photo composite (studio-cyc, silhouette) on ANY
 *  Gemini failure — rate limits, a missing/quota-exhausted key, a network
 *  blip — so a detail shot no photo can truly cover (glasses/cash/shoes
 *  props) degrades to "a real photo of the person" rather than crashing
 *  the whole build. Not the real prop shot, but always SOMETHING valid. */
const buildDetailStillImage = async (
  req: GenerationRequest,
  shot: string,
  seed: number,
  width: number,
  height: number,
  outImagePath: string,
): Promise<void> => {
  try {
    const bytes = await generateImage(detailPrompt(req, shot), req.identityImages, 3);
    const workDir = workDirFor("detail");
    try {
      const rawPath = path.join(workDir, "raw.png");
      fs.writeFileSync(rawPath, bytes);
      resizeCover(rawPath, width, height, outImagePath);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn(`modelShots: detailStill "${shot}" Gemini generation failed, falling back to a photo composite — ${(err as Error).message}`);
    // seed varies the fallback pick across sub-shots — without it every
    // failed detailStill in a triptych/montageReel would fall back to the
    // exact same photo, showing 3 identical panels instead of 3 distinct
    // (if degraded) ones.
    buildPlateStillImage(req, { plate: "studio-cyc", treatment: "silhouette", poseTag: "closeup", seed }, width, height, outImagePath);
  }
};

/** Builds ONE sub-shot's still image at (width, height), dispatching on
 *  its own kind — the shared step montageReel/triptych both fan out to. */
const buildSubShotImage = async (
  req: GenerationRequest,
  sub: SubShotSpec,
  width: number,
  height: number,
  outImagePath: string,
): Promise<void> => {
  if (sub.kind === "plateStill") {
    buildPlateStillImage(req, { plate: sub.plate, treatment: sub.treatment, poseTag: sub.poseTag, seed: sub.seed }, width, height, outImagePath);
  } else {
    await buildDetailStillImage(req, sub.shot, sub.seed, width, height, outImagePath);
  }
};

const concatClips = (clipPaths: string[], outPath: string): void => {
  const workDir = workDirFor("concat");
  try {
    const listPath = path.join(workDir, "list.txt");
    fs.writeFileSync(listPath, clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath]);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

const buildMontageReel = async (req: GenerationRequest): Promise<void> => {
  const subShots = req.subShots ?? [];
  if (subShots.length === 0) throw new Error("modelShots: montageReel needs at least one sub-shot");
  const perClipSec = req.durationSec / subShots.length;
  const workDir = workDirFor("montage-reel");
  try {
    const clipPaths: string[] = [];
    for (let i = 0; i < subShots.length; i++) {
      const stillPath = path.join(workDir, `still-${i}.png`);
      await buildSubShotImage(req, subShots[i], req.width, req.height, stillPath);
      const clipPath = path.join(workDir, `clip-${i}.mp4`);
      animateStillToClip(stillPath, { durationSec: perClipSec, width: req.width, height: req.height, fps: req.fps, outPath: clipPath });
      clipPaths.push(clipPath);
    }
    concatClips(clipPaths, req.outPath);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

const buildTriptych = async (req: GenerationRequest): Promise<void> => {
  const subShots = req.subShots ?? [];
  if (subShots.length === 0) throw new Error("modelShots: triptych needs at least one sub-shot");
  const panelHeight = Math.round(req.height / subShots.length / 2) * 2;
  const workDir = workDirFor("triptych");
  try {
    const panelPaths: string[] = [];
    for (let i = 0; i < subShots.length; i++) {
      const panelPath = path.join(workDir, `panel-${i}.png`);
      await buildSubShotImage(req, subShots[i], req.width, panelHeight, panelPath);
      panelPaths.push(panelPath);
    }
    const stackedPath = path.join(workDir, "stacked.png");
    // vstack needs matching widths (guaranteed — every panel built at
    // req.width) and doesn't itself guarantee the sum matches req.height
    // exactly (rounding panelHeight down to an even number can leave a
    // few px short) — pad/crop back to the exact canvas afterward.
    const inputs = panelPaths.flatMap((p) => ["-i", p]);
    execFileSync("ffmpeg", [
      "-y", "-v", "error",
      ...inputs,
      "-filter_complex",
      `${panelPaths.map((_, i) => `[${i}]`).join("")}vstack=${panelPaths.length},scale=${req.width}:${req.height}:force_original_aspect_ratio=increase,crop=${req.width}:${req.height}`,
      "-frames:v", "1",
      stackedPath,
    ]);
    animateStillToClip(stackedPath, { durationSec: req.durationSec, width: req.width, height: req.height, fps: req.fps, outPath: req.outPath });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

export const modelShotsGenerationProvider: GenerationProvider = {
  name: "model-shots",
  generate: async (req) => {
    if (req.identityImages.length === 0) {
      throw new Error("model-shots generation provider: no identity images to draw from");
    }

    switch (req.kind) {
      case "plateStill": {
        const workDir = workDirFor("still");
        try {
          const stillPath = path.join(workDir, "still.png");
          buildPlateStillImage(req, { plate: req.plate, treatment: req.treatment, poseTag: req.poseTag, seed: req.seed }, req.width, req.height, stillPath);
          animateStillToClip(stillPath, { durationSec: req.durationSec, width: req.width, height: req.height, fps: req.fps, outPath: req.outPath });
        } finally {
          fs.rmSync(workDir, { recursive: true, force: true });
        }
        return;
      }
      case "detailStill": {
        const workDir = workDirFor("detail-top");
        try {
          const stillPath = path.join(workDir, "still.png");
          await buildDetailStillImage(req, req.shot, req.seed, req.width, req.height, stillPath);
          animateStillToClip(stillPath, { durationSec: req.durationSec, width: req.width, height: req.height, fps: req.fps, outPath: req.outPath });
        } finally {
          fs.rmSync(workDir, { recursive: true, force: true });
        }
        return;
      }
      case "montageReel":
        return buildMontageReel(req);
      case "triptych":
        return buildTriptych(req);
      default:
        throw new Error(
          `model-shots generation provider: kind "${req.kind}" is not supported — use generation/gemini.ts or ` +
            `generation/higgsfield.ts for legacy cutaway/montage specs`,
        );
    }
  },
};

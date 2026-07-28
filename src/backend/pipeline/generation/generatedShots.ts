import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateImage } from "./geminiImage";
import { resizeCover } from "./matte";
import { loadPlatesManifest, platePath } from "./plates";
import { measureGeometry, measurePlateFidelity, bboxBottomInSeatBand, GeometryQC, PlateFidelityQC } from "./shotQC";
import { checkFaceMatch, checkPasteLook, checkPlateStructure, checkSofaPosture, FACE_MATCH_THRESHOLD } from "./faceCheck";
import { pickByPose } from "./identityPrep";
import { GenerationRequest } from "./provider";
import { PoseTag } from "../types";

/**
 * Real subject-into-scene generation — see the Kumar "Generated Shots v3"
 * plan. Replaces matte-compositing for every stylised shot: identity
 * photos + a checked-in backdrop plate + a pose/light description go IN,
 * one finished, coherent photograph comes OUT (real contact shadow,
 * correct scale, subject genuinely lit by the plate's own light) — not a
 * cutout pasted over a background.
 *
 * The retry/fallback ladder (plan §3) runs up to 3 paid Gemini attempts,
 * scored against a fixed set of hard gates (never ship: wrong face, wrong
 * set) and soft gates (aesthetic bands — framing, luma, edge cleanliness,
 * paste-look). A hard-gate failure that survives all 3 attempts tiers
 * down to the composite-v2 fallback (modelShots.ts's buildPlateStillImage
 * — the user's own real pixels, identity-safe by construction) rather
 * than ever shipping a wrong face. Every attempt's full QC record and the
 * shot's final `flag` (green/orange/red) are written to a `.qc.json`
 * sidecar next to the output — generate.ts reads it back into
 * inserts.json, and the contact sheet reads inserts.json.
 */

const workDirFor = (label: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `editable-genshots-${label}-`));

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const SUBJECT_BLOCK = (n: number) =>
  `SUBJECT — the person in the first ${n} reference photos. Preserve their exact facial identity, ` +
  `hairstyle, skin tone and build. Do not invent a different person, do not beautify.`;

const WARDROBE_BLOCK =
  `WARDROBE — the same dark top they wear in the reference photos, with plain black tailored trousers ` +
  `and black shoes. Head-to-toe dark, monochrome.`;

const sceneBlock = (mode: "A" | "B") =>
  mode === "A"
    ? `SCENE — the FINAL reference image is the exact backdrop plate. Treat it as the photograph being ` +
      `edited: place the subject INTO it and change nothing else about the scene — same wall tone, same ` +
      `brightness falloff, same floor line, no added furniture, no text.`
    : `SCENE — the FINAL reference image is the exact backdrop plate. Reproduce it faithfully (same wall ` +
      `tone, same brightness falloff, same floor line) and place the subject INTO it as if photographed ` +
      `there on the day.`;

/** Silhouette light language, two strengths — level 1 (attempt A1) is
 *  already stronger than the POC's own prompt (which measured as a
 *  normally-lit portrait despite asking for "near-silhouette... crushed
 *  near-black" — the model needs much more insistent, specific language
 *  than that to actually suppress visible clothing color/texture). Level
 *  2 (A2 retry) pushes further still with an explicit "if you can still
 *  see X, that's wrong" correction and a concrete near-black RGB target
 *  measured from the reference reel itself. */
const silhouetteLight = (strength: 1 | 2): string =>
  strength === 1
    ? `LIGHT — Backlit / rim-lit only: the key light sits BEHIND the subject; the camera-facing side is in ` +
      `deep shadow. The subject reads as a near-black SILHOUETTE — clothing color and fabric texture should ` +
      `NOT be visible or readable, only a dark human shape with a thin rim of light on the hair/shoulder ` +
      `edge. Underexpose the subject by at least 2-3 stops relative to the backdrop. Real contact shadow ` +
      `where the feet meet the floor, falling away from the key. Do not darken the backdrop — it stays ` +
      `bright and clean.`
    : `LIGHT — CRITICAL: this must read as a true SILHOUETTE, not a lit portrait. The subject's clothing, ` +
      `face and body should show almost NO visible color or texture — a flat near-black human outline ` +
      `(approximately RGB 5,5,5 or darker across clothing and shadowed skin) against the bright backdrop, ` +
      `like a person standing backlit in a doorway. If the shirt's color is identifiable or facial features ` +
      `read clearly, that is WRONG — push the subject darker until only the outline remains, with at most a ` +
      `thin rim-light edge on the hair/shoulders. The backdrop must stay bright and unchanged. Real contact ` +
      `shadow at the feet.`;

const litLight = () =>
  `LIGHT — Soft, frontal editorial key light. The subject is FULLY LIT — face, clothing texture and build ` +
  `all clearly visible, natural skin tones, no crushed shadow. The subject and the set are lit by the same ` +
  `source. Real contact shadow where the body meets the floor/furniture, falling away from the key. Do not ` +
  `darken the backdrop.`;

export const buildScenePrompt = (opts: {
  identityCount: number;
  mode: "A" | "B";
  treatment: "lit" | "silhouette";
  lightStrength: 1 | 2;
  posePrompt: string;
}): string =>
  [
    "Create a single photorealistic frame for a cinematic fashion-editorial reel.",
    "",
    SUBJECT_BLOCK(opts.identityCount),
    "",
    WARDROBE_BLOCK,
    "",
    sceneBlock(opts.mode),
    "",
    `POSE / FRAMING — ${opts.posePrompt}`,
    "",
    opts.treatment === "lit" ? litLight() : silhouetteLight(opts.lightStrength),
    "",
    "OUTPUT — one coherent photograph. No cut-out edges, no pasted look, no drop-shadow offset, no text " +
      "or watermark. Portrait 9:16.",
  ].join("\n");

// ---------------------------------------------------------------------------
// QC scoring
// ---------------------------------------------------------------------------

export type AttemptQC = {
  mode: "A" | "B";
  lightStrength: 1 | 2;
  geometry?: GeometryQC;
  plateFidelity?: PlateFidelityQC;
  faceMatchConfidence?: number;
  faceMatchDiffers?: string;
  pasteLook?: boolean;
  pasteLookReason?: string;
  plateSameSet?: boolean;
  plateAddedElements?: string;
  sofaOccluded?: boolean;
  sofaContactShadow?: boolean;
  sofaInBand?: boolean;
  hardGatesPassed: boolean;
  softGateFailures: string[];
};

const HARD_TARGET = { bboxMin: 0.75, subjectLumaMax: 25, backdropP90Min: 180, straightEdgeMax: 0.02 };
/** End card is "lit", not silhouette — its own reference framing/luma band
 *  (plan §7: "bbox 0.50-0.55H, luma p50 18±8 / p95 130±25") is a
 *  DIFFERENT shape from the standing-silhouette band above, not a laxer
 *  version of it. Its own vignette plate (matte.ts's generateVignetteBackdrop)
 *  also measures a lower mean luma (~168) than a bright white cyc, so its
 *  backdrop-brightness floor is set from that plate's own measurement, not
 *  the silhouette band's 180. */
const END_CARD_TARGET = { bboxMin: 0.5, bboxMax: 0.55, backdropP90Min: 140 };

const scoreAttempt = (
  qc: Omit<AttemptQC, "hardGatesPassed" | "softGateFailures">,
  isSofaShot: boolean,
  isEndCard: boolean,
): { hardGatesPassed: boolean; softGateFailures: string[] } => {
  const hardGatesPassed = (qc.faceMatchConfidence ?? 0) >= FACE_MATCH_THRESHOLD && qc.plateSameSet === true;

  const softGateFailures: string[] = [];
  if (qc.geometry) {
    const minBbox = isSofaShot ? 0.45 : isEndCard ? END_CARD_TARGET.bboxMin : HARD_TARGET.bboxMin;
    const maxBbox = isSofaShot ? 0.6 : isEndCard ? END_CARD_TARGET.bboxMax : 1;
    const backdropP90Min = isEndCard ? END_CARD_TARGET.backdropP90Min : HARD_TARGET.backdropP90Min;
    if (qc.geometry.bboxHeightFrac < minBbox || qc.geometry.bboxHeightFrac > maxBbox) softGateFailures.push("bboxHeightFrac");
    // A silhouette shot must crush near-black; the end card is deliberately
    // FULLY LIT (its own reference band centers on p50 18, well under 25
    // anyway, but the intent differs — this isn't "silhouette, but lucky").
    // Sofa's own backdrop tolerance is plate-relative (measurePlateFidelity)
    // rather than this absolute floor — an unlit couch plate legitimately
    // reads dimmer than a white cyc.
    if (!isEndCard && qc.geometry.subjectMedianLuma >= HARD_TARGET.subjectLumaMax) softGateFailures.push("subjectMedianLuma");
    if (!isSofaShot && qc.geometry.backdropP90 < backdropP90Min) softGateFailures.push("backdropP90");
    if (qc.geometry.straightEdgeRunFrac >= HARD_TARGET.straightEdgeMax) softGateFailures.push("straightEdgeRunFrac");
  } else {
    softGateFailures.push("geometryUnmeasurable");
  }
  if (qc.pasteLook === true) softGateFailures.push("pasteLook");
  if (isSofaShot) {
    if (qc.sofaOccluded !== true) softGateFailures.push("sofaOccluded");
    if (qc.sofaContactShadow !== true) softGateFailures.push("sofaContactShadow");
    if (qc.sofaInBand !== true) softGateFailures.push("sofaInBand");
  }

  return { hardGatesPassed, softGateFailures };
};

// ---------------------------------------------------------------------------
// One attempt
// ---------------------------------------------------------------------------

type AttemptPlan = { mode: "A" | "B"; lightStrength: 1 | 2; refOrder: string[] };

/** A failed attempt (network error, provider 5xx/429, safety refusal —
 *  anything generateImage itself throws) — a "generation didn't happen at
 *  all" QC record that fails every hard gate, not an infrastructure error
 *  the caller has to handle specially. Distinct from a QC check FAILING
 *  (which still ran and just says "no"): this is "there is no attempt to
 *  score." One shot's provider hiccup must not abort the other 8 shots'
 *  attempts, nor the whole generate stage — the ladder itself already
 *  exists to absorb exactly this kind of failure by moving to the next
 *  attempt plan (or tiering down if all three fail the same way). */
const FAILED_ATTEMPT_QC = (plan: AttemptPlan, message: string): AttemptQC => ({
  mode: plan.mode,
  lightStrength: plan.lightStrength,
  pasteLookReason: `generation call failed: ${message}`,
  hardGatesPassed: false,
  softGateFailures: ["generationFailed"],
});

const runAttempt = async (
  req: GenerationRequest,
  plan: AttemptPlan,
  posePrompt: string,
  plateFitPath: string,
  isSofaShot: boolean,
  seatBandFrac: { top: number; bottom: number } | undefined,
  workDir: string,
  attemptIndex: number,
): Promise<{ imagePath: string | undefined; qc: AttemptQC }> => {
  const prompt = buildScenePrompt({
    identityCount: plan.refOrder.length,
    mode: plan.mode,
    treatment: req.treatment ?? "silhouette",
    lightStrength: plan.lightStrength,
    posePrompt,
  });

  const refs = [...plan.refOrder, plateFitPath];
  let bytes: Buffer;
  try {
    bytes = await generateImage(prompt, refs, refs.length, { aspectRatio: "9:16", imageSize: "2K" });
  } catch (err) {
    console.warn(`generatedShots: attempt ${attemptIndex} (mode ${plan.mode}) generateImage failed — ${(err as Error).message}`);
    return { imagePath: undefined, qc: FAILED_ATTEMPT_QC(plan, (err as Error).message) };
  }
  const rawPath = path.join(workDir, `attempt-${attemptIndex}-raw.png`);
  fs.writeFileSync(rawPath, bytes);
  const finalPath = path.join(workDir, `attempt-${attemptIndex}-final.png`);
  resizeCover(rawPath, req.width, req.height, finalPath);

  const maskPath = path.join(workDir, `attempt-${attemptIndex}-mask.png`);
  const geometry = measureGeometry(finalPath, req.width, req.height, maskPath);
  const plateFidelity = geometry ? measurePlateFidelity(finalPath, plateFitPath, maskPath, req.width, req.height) : undefined;

  const facePhoto = plan.refOrder[0];
  const [faceResult, pasteResult, plateResult, sofaResult] = await Promise.all([
    checkFaceMatch(facePhoto, finalPath).catch((err) => {
      console.warn(`generatedShots: faceCheck failed — ${(err as Error).message}`);
      return { samePerson: false, confidence: 0, whatDiffers: "check failed" };
    }),
    checkPasteLook(finalPath).catch((err) => {
      console.warn(`generatedShots: pasteLook check failed — ${(err as Error).message}`);
      return { looksComposited: true, reason: "check failed" };
    }),
    checkPlateStructure(finalPath, plateFitPath).catch((err) => {
      console.warn(`generatedShots: plateStructure check failed — ${(err as Error).message}`);
      return { sameSet: false, addedElements: "check failed" };
    }),
    isSofaShot
      ? checkSofaPosture(finalPath).catch((err) => {
          console.warn(`generatedShots: sofaPosture check failed — ${(err as Error).message}`);
          return { occludedBySofa: false, cushionDeformation: false, contactShadowAtCushion: false, feetScalePlausible: false, notes: "check failed" };
        })
      : Promise.resolve(undefined),
  ]);

  const sofaInBand = isSofaShot && geometry && seatBandFrac ? bboxBottomInSeatBand(geometry.bboxBottom, req.height, seatBandFrac) : undefined;

  const qcBase = {
    mode: plan.mode,
    lightStrength: plan.lightStrength,
    geometry,
    plateFidelity,
    faceMatchConfidence: faceResult.confidence,
    faceMatchDiffers: faceResult.whatDiffers,
    pasteLook: pasteResult.looksComposited,
    pasteLookReason: pasteResult.reason,
    plateSameSet: plateResult.sameSet,
    plateAddedElements: plateResult.addedElements,
    sofaOccluded: sofaResult?.occludedBySofa,
    sofaContactShadow: sofaResult?.contactShadowAtCushion,
    sofaInBand,
  };
  const { hardGatesPassed, softGateFailures } = scoreAttempt(qcBase, isSofaShot, req.plate === "endcard-vignette");

  return { imagePath: finalPath, qc: { ...qcBase, hardGatesPassed, softGateFailures } };
};

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

export type SceneResult = {
  imagePath: string;
  flag: "green" | "orange" | "red";
  provider: string;
  attempts: AttemptQC[];
};

/** Runs the full retry ladder for ONE generatedScene shot and writes the
 *  chosen still to `outStillPath` (required, not optional — same reasoning
 *  as shotQC.ts's measureGeometry: every intermediate attempt lives in a
 *  scratch temp dir this function deletes before returning, so the winning
 *  image must be copied to a stable, caller-owned path before that happens
 *  rather than leaving a dangling path into an already-cleaned-up
 *  directory). Never throws on a QC failure — the ladder itself IS the
 *  failure handling; only a hard infrastructure error (network down, no
 *  API key at all) propagates. `tierDown` is called only if every attempt
 *  fails a hard gate — it's the caller's composite-v2 fallback
 *  (modelShots.ts's buildPlateStillImage), kept as an injected callback so
 *  this module doesn't need to import modelShots.ts (which would create a
 *  require cycle: modelShots.ts is what calls in here). */
export const generateSceneStill = async (
  req: GenerationRequest,
  spec: { plate: string; treatment: "lit" | "silhouette"; posePrompt: string; poseTag?: PoseTag; seed: number },
  outStillPath: string,
  tierDown: (outImagePath: string) => void,
): Promise<SceneResult> => {
  const manifest = loadPlatesManifest(req.formatId);
  const isSofaShot = spec.plate === "sofa";
  const seatBandFrac = manifest.plates[spec.plate]?.seatBandFrac;

  const workDir = workDirFor("scene");
  try {
    const plateFitPath = path.join(workDir, "plate-fit.png");
    resizeCover(platePath(req.formatId, manifest, spec.plate), req.width, req.height, plateFitPath);

    // Ref order: the plan's pose-donor idea — put the identity photo
    // matching this shot's poseTag first (e.g. a seated photo for the
    // sofa shot), everything else follows. Falls back to the seed-picked
    // photo when no photo carries that tag.
    const donor = pickByPose(req.identityImages, req.identityPoseTags, spec.poseTag, spec.seed);
    const rest = req.identityImages.filter((p) => p !== donor);
    const allRefsOrdered = [donor, ...rest];
    const closeup = pickByPose(req.identityImages, req.identityPoseTags, "closeup", spec.seed);

    const plans: AttemptPlan[] = [
      { mode: "A", lightStrength: 1, refOrder: allRefsOrdered },
      // A2: face close-up promoted to ref slot 1 (checkFaceMatch also
      // uses refOrder[0] as ITS OWN reference photo — promoting the
      // clearest face photo here sharpens both the generation prompt's
      // identity anchor and the QC comparison in the same move), stronger
      // silhouette language.
      { mode: "A", lightStrength: 2, refOrder: [closeup, ...req.identityImages.filter((p) => p !== closeup)] },
      // A3: best-3 refs (over-many refs can dilute identity per the
      // plan), Mode B as a structurally different fallback.
      { mode: "B", lightStrength: 2, refOrder: [closeup, donor, allRefsOrdered[allRefsOrdered.length - 1]].filter((p, i, a) => a.indexOf(p) === i) },
    ];

    const attempts: AttemptQC[] = [];
    let best: { imagePath: string | undefined; qc: AttemptQC } | undefined;

    for (let i = 0; i < plans.length; i++) {
      const result = await runAttempt(req, plans[i], spec.posePrompt, plateFitPath, isSofaShot, seatBandFrac, workDir, i);
      attempts.push(result.qc);

      const isBetter =
        !best ||
        (result.qc.hardGatesPassed && !best.qc.hardGatesPassed) ||
        (result.qc.hardGatesPassed === best.qc.hardGatesPassed && result.qc.softGateFailures.length < best.qc.softGateFailures.length);
      if (isBetter) best = result;

      if (result.qc.hardGatesPassed && result.qc.softGateFailures.length === 0) {
        // Green — stop spending on further attempts for this shot.
        break;
      }
    }

    if (!best || !best.qc.hardGatesPassed || !best.imagePath) {
      // Every attempt either failed a hard gate (wrong face or wrong set)
      // or never produced an image at all (provider error on every
      // attempt) — tier down to the identity-safe composite fallback
      // rather than ever ship a wrong face or a missing shot.
      tierDown(outStillPath);
      return { imagePath: outStillPath, flag: "red", provider: "composite-v2", attempts };
    }

    const flag: "green" | "orange" = best.qc.softGateFailures.length === 0 ? "green" : "orange";
    fs.copyFileSync(best.imagePath, outStillPath);
    return { imagePath: outStillPath, flag, provider: "gemini-3-pro-image", attempts };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GenerationProvider, GenerationRequest, animateStillToClip } from "./provider";
import { compositeOnBackdrop, resizeContainPad, resizeCover } from "./matte";
import { loadPlatesManifest, platePath } from "./plates";
import { formatAssetsDir } from "../paths";
import { measureSubjectBBox, computeSubjectTransform } from "./subjectFit";
import { measureSubjectLuma, solveSubjectRelight } from "./relight";
import { pickByPose } from "./identityPrep";
import { generateImage } from "./geminiImage";
import { generateSceneStill, SceneResult } from "./generatedShots";
import { animateStillWithDop } from "./higgsfieldDop";
import { extractCloseUpCutaway } from "../videoEffects";
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

/** Per-shot subjectFit target for a plateStill/composite-v2 tier-down —
 *  NOT one constant reused everywhere. Reusing the end-card's own 52%H
 *  framing for every plate still was the "subject half-size" defect the
 *  generated-shots plan called out by name: the reference's studio/couch
 *  cutaways read at ~80-82%H, nearly full-frame, not the end card's own
 *  smaller, headroom-for-title-text portrait framing. Disambiguated by
 *  plate, which already encodes shot identity 1:1 in this format (each
 *  plate is used for exactly one framing family):
 *   - "endcard-vignette" — the end card itself, the one shot that DOES
 *     want the smaller, lit, title-safe framing.
 *   - "sofa" — seated, anchored to the plate's own measured seat/floor
 *     band (PlateAssetSchema's seatBandFrac) so the bbox bottom lands on
 *     the cushion line, not floating mid-cushion or sunk into the floor.
 *   - anything else (studio-cyc, ...) — full-body standing/profile/
 *     closeup silhouettes, ~80%H with a small top margin so the head
 *     doesn't touch frame edge (mask-boundary rule: only feet may touch). */
const plateStillTarget = (manifest: PlatesManifest, plate: string | undefined): { topFrac: number; heightFrac: number } => {
  if (plate === "endcard-vignette") {
    return { topFrac: manifest.reference.endCard.subjectTopFrac, heightFrac: manifest.reference.endCard.subjectHeightFrac };
  }
  if (plate === "sofa") {
    const heightFrac = 0.5;
    const band = plate ? manifest.plates[plate]?.seatBandFrac : undefined;
    const bottomFrac = band ? (band.top + band.bottom) / 2 : 0.85;
    return { topFrac: Math.max(0, bottomFrac - heightFrac), heightFrac };
  }
  return { topFrac: 0.08, heightFrac: 0.8 };
};

/** Warns (never throws — this IS the terminal fallback tier, nothing left
 *  to escalate to) when the final composited subject's bbox touches a
 *  frame edge anywhere but the bottom (feet-on-floor is expected; any
 *  other edge touch is the straight-line "rectangle, not a person" defect
 *  resurfacing). Should not fire in practice once resizeContainPad keeps
 *  the source photo's own body away from its frame edges AND
 *  plateStillTarget's margins keep the target framing away from the
 *  canvas edges — kept as a cheap trip-wire against a future regression
 *  in either. */
const EDGE_TOUCH_MARGIN_FRAC = 0.01;
const warnIfBoundaryTouch = (bbox: { topFrac: number; leftFrac: number; rightFrac: number } | undefined, label: string): void => {
  if (!bbox) return;
  if (bbox.topFrac <= EDGE_TOUCH_MARGIN_FRAC || bbox.leftFrac <= EDGE_TOUCH_MARGIN_FRAC || bbox.rightFrac >= 1 - EDGE_TOUCH_MARGIN_FRAC) {
    console.warn(`modelShots: "${label}" composite-v2 subject bbox touches a non-bottom frame edge — likely a crop-line, not a body silhouette`);
  }
};

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
  const target = plateStillTarget(manifest, spec.plate);

  const workDir = workDirFor("plate");
  try {
    const backdropSized = path.join(workDir, "backdrop.png");
    resizeCover(backdropAbs, width, height, backdropSized);
    // Contain-fit, not cover-fit: the identity photo's full body must
    // survive into the frame matte.swift segments, or the mask boundary
    // it finds is the photo's own crop line, not the person's silhouette
    // (see resizeContainPad's doc comment).
    const subjectSized = path.join(workDir, "subject.png");
    resizeContainPad(subjectPhoto, width, height, subjectSized);

    let lastBBox: ReturnType<typeof measureSubjectBBox>;
    compositeOnBackdrop({
      subjectImagePath: subjectSized,
      backdropPath: backdropSized,
      outPath: outImagePath,
      silhouette: treatment === "silhouette",
      shadow: false,
      calibrate: (matteInDir, matteOutDir) => {
        const bbox = measureSubjectBBox(matteOutDir, width, height);
        lastBBox = bbox;
        const subjectTransform = computeSubjectTransform(bbox, target, width, height);
        if (treatment !== "lit") return { subjectTransform };
        const measured = measureSubjectLuma(matteInDir, matteOutDir, 1);
        const subjectFilter = measured
          ? solveSubjectRelight(measured, { p50: manifest.reference.endCard.lumaP50, p95: manifest.reference.endCard.lumaP95 })
          : undefined;
        return { subjectTransform, subjectFilter };
      },
    });
    warnIfBoundaryTouch(lastBBox, spec.plate ?? "plateStill");
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
): Promise<{ tier: "gemini" | "composite" }> => {
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
    return { tier: "gemini" };
  } catch (err) {
    console.warn(`modelShots: detailStill "${shot}" Gemini generation failed, falling back to a photo composite — ${(err as Error).message}`);
    // seed varies the fallback pick across sub-shots — without it every
    // failed detailStill in a triptych/montageReel would fall back to the
    // exact same photo, showing 3 identical panels instead of 3 distinct
    // (if degraded) ones.
    buildPlateStillImage(req, { plate: "studio-cyc", treatment: "silhouette", poseTag: "closeup", seed }, width, height, outImagePath);
    return { tier: "composite" };
  }
};

/** Where a generatedScene slot's own chosen still is persisted — the
 *  "reuse" sub-shot kind (montageReel members that replay an already-
 *  generated shot instead of paying to generate a near-duplicate) reads
 *  from here rather than calling any provider. */
const stillsDir = (jobDir: string): string => path.join(jobDir, "generated", "stills");
const stillPathFor = (jobDir: string, slotName: string): string => path.join(stillsDir(jobDir), `${slotName}.png`);

/** `outPath` for a top-level slot is "generated/<slotName>.mp4" — derive
 *  the slot name back out of it rather than threading a separate field
 *  through GenerationRequest. */
const slotNameFromOutPath = (outPath: string): string => path.basename(outPath, ".mp4");

/** Composite-v2 tier-down for a generatedScene shot whose Gemini attempts
 *  never cleared identity — reuses the SAME deterministic photo-on-plate
 *  composite plateStill already is, at the failed shot's own plate/
 *  treatment/pose. Identity-safe by construction (the user's own pixels),
 *  which is the whole point of a tier-down.
 *
 *  `req.strict` (GenerationRequest doc comment) skips the tier-down
 *  entirely and throws instead, naming `label` — see this file's own
 *  ShotTier doc comment for why a silent tier-down is worth being able to
 *  turn into a hard failure. */
const compositeV2TierDown = (
  req: GenerationRequest,
  spec: { plate: string; treatment: "lit" | "silhouette"; poseTag?: PoseTag; seed: number },
  width: number,
  height: number,
  label: string,
) => (outImagePath: string): void => {
  if (req.strict) {
    throw new Error(
      `modelShots: "${label}" exhausted its generation ladder without clearing hard gates — refusing to ` +
        `silently tier down to composite-v2 (STRICT_GENERATION=1). Retry, or unset STRICT_GENERATION to allow the fallback.`,
    );
  }
  buildPlateStillImage(req, spec, width, height, outImagePath);
};

/** Which generation path actually produced a shot's pixels — the plan's
 *  own "tier truth" requirement: a shot's `flag` (green/orange/red) says
 *  how well QC scored it, but doesn't say WHETHER it's actually the
 *  AI-generated pose that was asked for, or the identity-safe fallback
 *  wearing the user's own real clothes. Surfaced per-member for
 *  montageReel/triptych (see buildMontageReel/buildTriptych's own
 *  `members` collection) so a tier-down is visible in the contact sheet
 *  and job.json instead of only showing up as a trouser-color mismatch a
 *  human happens to notice. */
export type ShotTier = "gemini" | "composite" | "reuse" | "realCrop" | "templateClip";

/** Persisted the SAME way a top-level generatedScene slot's own still is
 *  (see modelShotsGenerationProvider's "generatedScene" case) — montage/
 *  triptych MEMBERS never had this before, so a member that regenerated
 *  during a later run (network flake, retry, whatever) with no cached
 *  still to reuse was gone for good, unrecoverable without a fresh
 *  Gemini spend. `parentSlotName`/`memberIndex` name the file; every
 *  member gets one regardless of which tier it actually landed on
 *  (composite/reuse members too — cheap, and keeps the directory a
 *  complete record of "what actually rendered" for this job). */
const memberStillPath = (jobDir: string, parentSlotName: string, memberIndex: number): string =>
  path.join(stillsDir(jobDir), `${parentSlotName}__member-${memberIndex}.png`);

/** Builds ONE sub-shot's still image at (width, height), dispatching on
 *  its own kind — the shared step montageReel/triptych both fan out to.
 *  Returns the shot's own flag when it ran a QC ladder (generatedScene);
 *  undefined for a sub-shot kind with no ladder of its own (plateStill,
 *  detailStill, reuse — a reuse's quality is whatever its source shot's
 *  flag already was, tracked on THAT shot's own top-level insert, not
 *  duplicated here). `memberContext`, when given, additionally persists
 *  this member's own still (see memberStillPath's doc comment). */
const buildSubShotImage = async (
  req: GenerationRequest,
  sub: SubShotSpec,
  width: number,
  height: number,
  outImagePath: string,
  memberContext?: { parentSlotName: string; memberIndex: number },
): Promise<{ flag?: "green" | "orange" | "red"; tier: ShotTier }> => {
  const persistMember = () => {
    if (!memberContext) return;
    fs.mkdirSync(stillsDir(req.jobDir), { recursive: true });
    fs.copyFileSync(outImagePath, memberStillPath(req.jobDir, memberContext.parentSlotName, memberContext.memberIndex));
  };

  if (sub.kind === "plateStill") {
    buildPlateStillImage(req, { plate: sub.plate, treatment: sub.treatment, poseTag: sub.poseTag, seed: sub.seed }, width, height, outImagePath);
    persistMember();
    return { tier: "composite" };
  }
  if (sub.kind === "detailStill") {
    const { tier } = await buildDetailStillImage(req, sub.shot, sub.seed, width, height, outImagePath);
    persistMember();
    return { tier };
  }
  if (sub.kind === "reuse") {
    if (!sub.reuseSlot) throw new Error("modelShots: reuse sub-shot needs a reuseSlot");
    const sourcePath = stillPathFor(req.jobDir, sub.reuseSlot);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(
        `modelShots: reuse sub-shot references "${sub.reuseSlot}", but no still is saved for it yet — ` +
          `the reused slot's own block must come BEFORE this one in the format's block order`,
      );
    }
    // A horizontal flip is enough to keep a reused shot from reading as a
    // literal repeat of the shot it's reused from (different silhouette
    // orientation, arms cross the other way) without needing real
    // pan-direction zoompan plumbing for what's otherwise the exact same
    // still.
    if (sub.panDirection === "left" || sub.panDirection === "right") {
      execFileSync("ffmpeg", ["-y", "-v", "error", "-i", sourcePath, "-vf", "hflip", outImagePath]);
    } else {
      fs.copyFileSync(sourcePath, outImagePath);
    }
    persistMember();
    return { tier: "reuse" };
  }
  // generatedScene sub-shot (montage-1/2/3 in the shot pack — real
  // generation targets declared inline as montageReel members rather
  // than separate top-level slots).
  if (!sub.plate || !sub.posePrompt) throw new Error(`modelShots: generatedScene sub-shot "${sub.shot}" needs plate + posePrompt`);
  const spec = { plate: sub.plate, treatment: sub.treatment, poseTag: sub.poseTag, seed: sub.seed };
  const memberLabel = memberContext ? `${memberContext.parentSlotName} member ${memberContext.memberIndex} (${sub.shot})` : sub.shot;
  const result = await generateSceneStill(
    { ...req, plate: sub.plate, treatment: sub.treatment },
    { plate: sub.plate, treatment: sub.treatment, posePrompt: sub.posePrompt, poseTag: sub.poseTag, seed: sub.seed },
    outImagePath,
    compositeV2TierDown(req, spec, width, height, memberLabel),
  );
  persistMember();
  return { flag: result.flag, tier: result.provider === "composite-v2" ? "composite" : "gemini" };
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

/** A multi-member shot (montageReel/triptych) is only as good as its
 *  worst member — red beats orange beats green when aggregating. */
const FLAG_RANK: Record<"green" | "orange" | "red", number> = { green: 0, orange: 1, red: 2 };
const worstFlag = (flags: Array<"green" | "orange" | "red" | undefined>): "green" | "orange" | "red" | undefined => {
  const present = flags.filter((f): f is "green" | "orange" | "red" => f !== undefined);
  if (present.length === 0) return undefined;
  return present.reduce((worst, f) => (FLAG_RANK[f] > FLAG_RANK[worst] ? f : worst));
};

export type MemberTierRecord = { label: string; tier: ShotTier; flag?: "green" | "orange" | "red" };

const buildMontageReel = async (req: GenerationRequest): Promise<{ flag?: "green" | "orange" | "red"; members: MemberTierRecord[] }> => {
  const subShots = req.subShots ?? [];
  if (subShots.length === 0) throw new Error("modelShots: montageReel needs at least one sub-shot");
  const perClipSec = req.durationSec / subShots.length;
  const parentSlotName = slotNameFromOutPath(req.outPath);
  const workDir = workDirFor("montage-reel");
  try {
    const clipPaths: string[] = [];
    const flags: Array<"green" | "orange" | "red" | undefined> = [];
    const members: MemberTierRecord[] = [];
    for (let i = 0; i < subShots.length; i++) {
      const stillPath = path.join(workDir, `still-${i}.png`);
      const { flag, tier } = await buildSubShotImage(req, subShots[i], req.width, req.height, stillPath, { parentSlotName, memberIndex: i });
      flags.push(flag);
      members.push({ label: subShots[i].shot, tier, flag });
      const clipPath = path.join(workDir, `clip-${i}.mp4`);
      animateStillToClip(stillPath, { durationSec: perClipSec, width: req.width, height: req.height, fps: req.fps, outPath: clipPath });
      clipPaths.push(clipPath);
    }
    concatClips(clipPaths, req.outPath);
    return { flag: worstFlag(flags), members };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

const probeDurationSec = (absPath: string): number => {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", absPath]).toString().trim();
  return Number(out) || 0;
};

/** Builds ONE triptych panel as a durationSec-long VIDEO clip at
 *  (width, panelHeight) — NOT a still, unlike montageReel's own members:
 *  each panel needs its OWN independent motion (SubShotSpecSchema's
 *  motion doc comment), which a single shared Ken-Burns push over one
 *  flattened stacked image can't produce (measured: the reference's cash
 *  panel moves ~24 luma/frame, ~40x a silhouette still's own push). */
const buildTriptychPanelClip = async (
  req: GenerationRequest,
  sub: SubShotSpec,
  width: number,
  panelHeight: number,
  durationSec: number,
  outClipPath: string,
  memberContext: { parentSlotName: string; memberIndex: number },
): Promise<{ flag?: "green" | "orange" | "red"; tier: ShotTier }> => {
  if (sub.motion === "realCrop") {
    if (!req.speakingTakePath) {
      throw new Error(`modelShots: triptych realCrop panel "${sub.shot}" needs the format's own speakingTakeSlot`);
    }
    // A FRACTION of the take's own total duration, not an absolute second
    // count — see SubShotSpecSchema's realCropAtFrac doc comment for why
    // (every user's take runs a different length).
    const takeDurationSec = probeDurationSec(req.speakingTakePath);
    const atSec = Math.max(0, Math.min(takeDurationSec - durationSec, (sub.realCropAtFrac ?? 0.75) * takeDurationSec));
    extractCloseUpCutaway(req.speakingTakePath, outClipPath, {
      atSec,
      durationSec,
      width,
      height: panelHeight,
      zoom: 0.32,
      yBias: 0.35,
    });
    fs.mkdirSync(stillsDir(req.jobDir), { recursive: true });
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", outClipPath, "-frames:v", "1", memberStillPath(req.jobDir, memberContext.parentSlotName, memberContext.memberIndex)]);
    return { tier: "realCrop" };
  }
  if (sub.motion === "templateClip") {
    if (!sub.templateClipPath) throw new Error(`modelShots: triptych templateClip panel "${sub.shot}" needs a templateClipPath`);
    const absTemplateClipPath = path.join(formatAssetsDir(req.formatId), sub.templateClipPath);
    if (!fs.existsSync(absTemplateClipPath)) {
      throw new Error(`modelShots: templateClipPath "${sub.templateClipPath}" not found at ${absTemplateClipPath}`);
    }
    // Middle window, not the first durationSec seconds — same reasoning
    // as the "dop" case just below: a generated video's own motion
    // typically ramps up from a quieter start rather than staying
    // uniform throughout, so the opening seconds read as the LEAST
    // animated part (measured directly on this format's own shoe/cash
    // clips: the first 1.8s of a 5.4s DoP render measured under half the
    // motion signature of its own middle window).
    const templateDurationSec = probeDurationSec(absTemplateClipPath);
    const windowStart = Math.max(0, (templateDurationSec - durationSec) / 2);
    execFileSync("ffmpeg", [
      "-y", "-v", "error",
      "-ss", String(windowStart),
      "-i", absTemplateClipPath,
      "-t", String(durationSec),
      "-vf", `scale=${width}:${panelHeight}:force_original_aspect_ratio=increase,crop=${width}:${panelHeight}`,
      "-an",
      outClipPath,
    ]);
    fs.mkdirSync(stillsDir(req.jobDir), { recursive: true });
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", outClipPath, "-frames:v", "1", memberStillPath(req.jobDir, memberContext.parentSlotName, memberContext.memberIndex)]);
    return { tier: "templateClip" };
  }

  const workDir = workDirFor("triptych-panel");
  try {
    const stillPath = path.join(workDir, "still.png");
    const { flag, tier } = await buildSubShotImage(req, sub, width, panelHeight, stillPath, memberContext);

    if (sub.motion === "dop") {
      try {
        const bytes = await animateStillWithDop(stillPath, sub.motionPrompt ?? sub.shot);
        const rawClipPath = path.join(workDir, "dop-raw.mp4");
        fs.writeFileSync(rawClipPath, bytes);
        // DoP's own output duration/resolution won't match this panel's
        // slot exactly — take the MIDDLE durationSec-long window (motion
        // reads most natural mid-clip, not during its own startup/settle)
        // and resize onto the panel's target canvas.
        const probeSec = probeDurationSec(rawClipPath);
        const windowStart = Math.max(0, (probeSec - durationSec) / 2);
        execFileSync("ffmpeg", [
          "-y", "-v", "error",
          "-ss", String(windowStart),
          "-i", rawClipPath,
          "-t", String(durationSec),
          "-vf", `scale=${width}:${panelHeight}:force_original_aspect_ratio=increase,crop=${width}:${panelHeight}`,
          "-an",
          outClipPath,
        ]);
        return { flag, tier };
      } catch (err) {
        console.warn(`modelShots: triptych DoP animation failed for "${sub.shot}", falling back to a still push — ${(err as Error).message}`);
        animateStillToClip(stillPath, { durationSec, width, height: panelHeight, fps: req.fps, outPath: outClipPath });
        return { flag, tier };
      }
    }

    animateStillToClip(stillPath, { durationSec, width, height: panelHeight, fps: req.fps, outPath: outClipPath });
    return { flag, tier };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

/** Panel height fractions top-to-bottom (eyes/cash/shoes), measured
 *  against the reference's own triptych seams (~0.35H, ~0.67H) — not
 *  equal thirds, the top panel reads slightly taller. Falls back to
 *  equal division for a subShots count other than 3 (a format author
 *  changing the panel count loses the measured proportions, not
 *  correctness). */
const TRIPTYCH_PANEL_HEIGHT_FRACS = [0.35, 0.32, 0.33];

const buildTriptych = async (req: GenerationRequest): Promise<{ flag?: "green" | "orange" | "red"; members: MemberTierRecord[] }> => {
  const subShots = req.subShots ?? [];
  if (subShots.length === 0) throw new Error("modelShots: triptych needs at least one sub-shot");
  const heightFracs = subShots.length === TRIPTYCH_PANEL_HEIGHT_FRACS.length
    ? TRIPTYCH_PANEL_HEIGHT_FRACS
    : subShots.map(() => 1 / subShots.length);
  const panelHeights = heightFracs.map((f) => Math.round((req.height * f) / 2) * 2);
  // Rounding each panel to an even height independently can leave the
  // sum a few px off req.height — the vstack+crop pass below absorbs
  // that the same way the old equal-thirds version already did.
  const parentSlotName = slotNameFromOutPath(req.outPath);

  const workDir = workDirFor("triptych");
  try {
    const clipPaths: string[] = [];
    const flags: Array<"green" | "orange" | "red" | undefined> = [];
    const members: MemberTierRecord[] = [];
    for (let i = 0; i < subShots.length; i++) {
      const clipPath = path.join(workDir, `panel-${i}.mp4`);
      const { flag, tier } = await buildTriptychPanelClip(req, subShots[i], req.width, panelHeights[i], req.durationSec, clipPath, { parentSlotName, memberIndex: i });
      flags.push(flag);
      members.push({ label: subShots[i].shot, tier, flag });
      clipPaths.push(clipPath);
    }
    // Video vstack (not an image stack + single shared push): each input
    // is already its own durationSec-long clip with its own motion —
    // stacking the VIDEO streams keeps every panel's own motion intact
    // instead of flattening to one frame and animating the whole thing
    // uniformly (the "still masquerading as a moving shot" defect this
    // whole rewrite exists to fix).
    // Each panel's own clip may have come from a different native frame
    // rate (realCrop inherits the speaking-take's own fps; DoP's output
    // has its own) — normalize every input to req.fps BEFORE vstack, or
    // mismatched rates going into the same stack can misalign/stutter.
    const inputs = clipPaths.flatMap((p) => ["-i", p]);
    const normalized = clipPaths.map((_, i) => `[${i}:v]fps=${req.fps}[v${i}]`).join(";");
    const stackInputs = clipPaths.map((_, i) => `[v${i}]`).join("");
    execFileSync("ffmpeg", [
      "-y", "-v", "error",
      ...inputs,
      "-filter_complex",
      `${normalized};${stackInputs}vstack=${clipPaths.length},scale=${req.width}:${req.height}:force_original_aspect_ratio=increase,crop=${req.width}:${req.height}[v]`,
      "-map", "[v]",
      "-r", String(req.fps),
      "-t", String(req.durationSec),
      "-an",
      req.outPath,
    ]);
    return { flag: worstFlag(flags), members };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

/** generate.ts reads this back (regardless of cache hit/miss) into
 *  inserts.json's own flag/qc fields — see generate.ts's doc comment on
 *  qcSidecarPath. `attempts` (the full per-attempt QC record) is kept
 *  even for a non-generatedScene shot's empty case, so the shape is
 *  uniform for the contact-sheet builder. */
const writeQcSidecar = (outPath: string, flag: "green" | "orange" | "red" | undefined, qc: { members?: MemberTierRecord[] } & Record<string, unknown>): void => {
  // Written whenever there's SOMETHING worth recording — a QC flag, or (a
  // montageReel/triptych with no flag of its own, e.g. every member is a
  // plain composite with no generation ladder) at least the per-member
  // tier breakdown, so tier truth is never silently absent just because
  // nothing failed a QC gate.
  if (flag === undefined && !qc.members?.length) return;
  fs.writeFileSync(`${outPath}.qc.json`, JSON.stringify({ flag, qc }, null, 2));
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
      case "generatedScene": {
        if (!req.plate || !req.posePrompt) throw new Error(`model-shots: generatedScene slot needs a plate + posePrompt (shot: "${req.shot}")`);
        const slotName = slotNameFromOutPath(req.outPath);
        const spec = { plate: req.plate, treatment: req.treatment ?? "silhouette", poseTag: req.poseTag, seed: req.seed };
        const workDir = workDirFor("scene-top");
        try {
          const stillPath = path.join(workDir, "still.png");
          const result: SceneResult = await generateSceneStill(
            req,
            { ...spec, posePrompt: req.posePrompt },
            stillPath,
            compositeV2TierDown(req, spec, req.width, req.height, slotName),
          );
          // Persisted for any LATER block's montageReel "reuse" sub-shot
          // (see buildSubShotImage's "reuse" case) — this block must come
          // before that one in the format's own block order for the file
          // to exist by then, which the format restructure guarantees.
          fs.mkdirSync(stillsDir(req.jobDir), { recursive: true });
          fs.copyFileSync(stillPath, stillPathFor(req.jobDir, slotName));
          animateStillToClip(stillPath, { durationSec: req.durationSec, width: req.width, height: req.height, fps: req.fps, outPath: req.outPath });
          const tier: ShotTier = result.provider === "composite-v2" ? "composite" : "gemini";
          writeQcSidecar(req.outPath, result.flag, { attempts: result.attempts, provider: result.provider, tier });
        } finally {
          fs.rmSync(workDir, { recursive: true, force: true });
        }
        return;
      }
      case "montageReel": {
        const { flag, members } = await buildMontageReel(req);
        writeQcSidecar(req.outPath, flag, { note: "worst flag among montageReel sub-shots", members });
        return;
      }
      case "triptych": {
        const { flag, members } = await buildTriptych(req);
        writeQcSidecar(req.outPath, flag, { note: "worst flag among triptych sub-shots", members });
        return;
      }
      default:
        throw new Error(
          `model-shots generation provider: kind "${req.kind}" is not supported — use generation/gemini.ts or ` +
            `generation/higgsfield.ts for legacy cutaway/montage specs`,
        );
    }
  },
};

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeFile } from "./intake";
import { applyLateralFalloff, compositeSubjectAlphaVideo, compositeVideoOnBackdrop, generateVignetteBackdrop, resizeCover, SubjectTransform } from "./generation/matte";
import { deskForegroundPath, loadPlatesManifest, platePath } from "./generation/plates";
import { measureSubjectBBox, measureHeadBBox, computeSubjectTransform, SubjectBBoxFrac } from "./generation/subjectFit";
import { measureSubjectLuma, solveSubjectRelight } from "./generation/relight";
import {
  applyFilterToImage,
  measureSubjectSharpness,
  solveDirectionalKey,
  solveGrainStrengthOnVideo,
  solvePlateBlurSigma,
  solveRoomLevelGain,
  solveWarmthFilter,
} from "./generation/officeCompositeQC";
import { applyPunchInTail, extractCloseUpCutaway } from "./videoEffects";
import { PIPELINE_VERSION } from "./pipelineVersion";
import { Block, BoundAsset, FilledFormat, Format, MatteArtifact, MatteBlock, PlatesManifest, Transcript, TrimPoints } from "./types";

/**
 * Module 3.5 — Per-block video post-processing for single-take formats:
 * `backgroundReplace` and `punchInTailSec` (see schemas.ts's BlockSchema
 * doc comment for both). Runs after trim/split (needs each block's own
 * span within the shared take) and before resolveRoles/assemble (both
 * need the REPLACED bindings/trims, not the shared-take ones).
 *
 * backgroundReplace: composites the subject onto the format's checked-in
 * office plate (formats/assets/<formatId>/, see PlatesManifestSchema) —
 * the SAME plate for every user of this format, not a per-job generated
 * one, so "swap the background for the reference's own office" is a
 * guarantee, not a prompt's best effort. A single-take format is one
 * continuous take from one camera position, so every flagged block shares
 * that one plate, matching generate.ts generating one montage insert
 * rather than a different one per block. Two things happen alongside the
 * plate swap, both measured from the subject's own matted pixels (no
 * manual per-job tuning): subjectFit.ts scales/positions the cutout so its
 * head lands where the reference's own head sits, and relight.ts remaps
 * its luma distribution onto the reference's — together, the fix for a
 * subject shot in ordinary bright daylight otherwise reading as a flat
 * cutout pasted onto a dark plate. A desk-foreground strip (also part of
 * the plate) composites LAST, on top of the subject, so they appear to
 * sit BEHIND the keyboard/notebook exactly like the reference.
 *
 * punchInTailSec: independent of backgroundReplace — crops+zooms the last
 * N seconds into a tight close-up (videoEffects.ts), applied on top of
 * whichever video is otherwise this block's own (background-replaced or
 * as-filmed).
 *
 * plateComposite / silhouette (broll blocks only, e.g. the end card): a
 * DIFFERENT treatment from backgroundReplace, not a variant of it — no
 * shared take to slice a span out of, since a broll block owns its clip
 * directly, and each broll block may composite onto a DIFFERENT plate
 * (the end card onto "studio-cyc", a couch cutaway onto "sofa", ...).
 * Takes a brollDurationSec-long window, CENTERED in the block's own bound
 * video (not the tail — a "walk in, hold, walk out" take has its held
 * pose in the middle; tail-anchoring shipped as a real bug here once,
 * landing mid-exit instead of mid-hold). "silhouette" treatment crushes
 * the subject dark (matte.ts's SILHOUETTE_CRUSH); "lit" keeps them at
 * relit-but-not-crushed brightness, fit to the reference's own end-card
 * subject proportions — for shots the reference shows fully lit, where
 * crushing to a silhouette would be wrong.
 *
 * Any of these flags REBINDS the block's binding/trim entry to a new,
 * standalone file afterward: unlike the shared take (one file, many
 * blocks' spans inside it), a processed block now owns its own file
 * starting at 0 — its TrimPoints entry is rewritten to match. A voice
 * block's Transcript words are REBASED the same way (subtracting the
 * original take-relative srcInSec): they're computed once, upstream, in
 * the shared take's own coordinate space, and resolveRoles/assemble
 * downstream both interpret word times as relative to the block's OWN
 * clip — leaving them take-relative after rebinding the trim to start at
 * 0 silently produces garbage anchor spans (this shipped as exactly that
 * bug once: overlays computing an end before their start and getting
 * dropped). Broll blocks have no transcript to rebase.
 */

const requestHash = (parts: Record<string, unknown>): string =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify({ ...parts, pipelineVersion: PIPELINE_VERSION }))
    .digest("hex")
    .slice(0, 16);

/** Runs one ffmpeg call, only if `hashFile` doesn't already match `hash` —
 *  the same cache-by-hash-sidecar shape generate.ts uses for its inserts.
 *  Also clears any stale sibling intermediates left in `generatedDir` by a
 *  PREVIOUS build of this same output (e.g. a punch-in's own composited
 *  source) — otherwise a changed pipeline version leaves the old file's
 *  intermediates on disk forever, orphaned and never referenced again. */
const withCache = (outPath: string, hash: string, build: () => void): void => {
  const hashFile = `${outPath}.hash`;
  const cached = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, "utf8") : undefined;
  if (cached === hash && fs.existsSync(outPath)) return;
  build();
  fs.writeFileSync(hashFile, hash);
};

/** `block.plateComposite`, or the legacy `silhouette: true` shorthand
 *  normalized into the same shape — the one place either field is read,
 *  so everything downstream sees one resolved shape. */
const resolvePlateComposite = (block: Block): { plate: string; treatment: "lit" | "silhouette" } | undefined => {
  if (block.plateComposite) return block.plateComposite;
  if (block.silhouette) return { plate: "studio-cyc", treatment: "silhouette" as const };
  return undefined;
};

/** Measures the subject's bbox/luma from just-extracted frames+masks and
 *  derives the subjectTransform (always) and subjectFilter (only when
 *  `lumaTarget` is given — skipped for a silhouette treatment, since
 *  SILHOUETTE_CRUSH already does the darkening and stacking a relight
 *  curve under it would just fight the crush). Shared by both the
 *  talking-head office composite and the broll plate composites below.
 *
 *  `useHeadFraming`, when true, switches the framing measurement from
 *  whole-person to head-only: the framing target (topFrac/heightFrac) is
 *  a HEAD measurement for the talking-head shot, and fitting it against
 *  measureSubjectBBox's whole-person bbox scales the entire seated
 *  person to head size — the "half life-size" defect this exists to fix
 *  (see subjectFit.ts's measureHeadBBox doc comment).
 *
 *  The relight curve itself stays anchored to the WHOLE-SUBJECT
 *  p50/p95 (not the face region specifically) — a face-anchored midtone
 *  was tried and measured directly: it does brighten the face, but the
 *  SAME curve applies to every other subject pixel too (clothing, hair),
 *  and anchoring the midtone to the face's own (brighter) value steepens
 *  the low-end slope enough to noticeably over-brighten the whole
 *  composite (measured: whole-frame p50 jumped from the reference's own
 *  ~14-17 to ~69-74). The scale fix ABOVE turns out to already fix most
 *  of the face-too-dark complaint on its own (a correctly-sized head is a
 *  much larger fraction of the sampled subject mask, measured face patch
 *  34→37 with the plain whole-subject curve unmodified) without needing
 *  a face-specific curve override that unbalances everything else. */
const calibrateSubject = (
  target: { topFrac: number; heightFrac: number },
  lumaTarget: { p50: number; p95: number } | undefined,
  width: number,
  height: number,
  useHeadFraming?: boolean,
) => (framesDir: string, masksDir: string) => {
  const bbox = useHeadFraming ? measureHeadBBox(masksDir, width, height) : measureSubjectBBox(masksDir, width, height);
  const subjectTransform = computeSubjectTransform(bbox, target, width, height);
  if (!lumaTarget) return { subjectTransform };
  const measured = measureSubjectLuma(framesDir, masksDir);
  if (!measured) return { subjectTransform };
  const subjectFilter = solveSubjectRelight(measured, lumaTarget);
  return { subjectTransform, subjectFilter };
};

/** Overlap margin beyond the desk foreground's own alpha midpoint
 *  (`deskEdgeFrac`) — the subject should visibly continue a little past
 *  the desk edge so the desk reads as OCCLUDING the body, not just
 *  touching it at a coincidental seam. */
const DESK_OVERLAP_MARGIN_FRAC = 0.02;

/** How far the framing solve may scale UP beyond the head target before
 *  giving up and shifting the whole framing down instead. Scaling up
 *  keeps the head TOP anchored (computeSubjectTransform's own yOffset
 *  formula, recomputed at the larger scale) — zero impact on the
 *  karaoke-title baseline — so it's tried first; a subject who's
 *  otherwise well-framed but just short of the desk shouldn't have their
 *  whole composition shifted for the sake of a few extra percent scale. */
const DESK_OVERLAP_MAX_SCALE_BOOST = 0.10;

/** Floor for how far down the framing may shift to reach the desk — the
 *  karaoke title (schemas.ts's captionVariant doc) needs the head to stay
 *  above roughly this line to have room to read behind it. */
const MIN_HEAD_TOP_FRAC = 0.20;

type DeskOverlapResult = {
  subjectTransform: SubjectTransform;
  /** Set only when the solve shifted the framing down from the manifest's
   *  own headTopFrac target — the karaoke-title baseline (assemble.ts)
   *  must follow the head, or the title registers against where the head
   *  WOULD have been rather than where it actually landed. */
  actualHeadTopFrac?: number;
};

/**
 * Fits the subject's head to the manifest's target (headTopFrac/
 * headHeightFrac, computeSubjectTransform's own job), then checks whether
 * the WHOLE PERSON'S bottom edge — after that same uniform transform —
 * reaches past the desk foreground's own edge. A source take that's tight
 * head-and-shoulders (or where Vision/RVM's own mask clips the body early)
 * leaves the subject's torso ending in mid-air above the desk with nothing
 * constraining it; this is the fix (see this rework's own investigation:
 * `computeSubjectTransform` only ever fit head-top/height, never checked
 * where the rest of the body landed).
 *
 * Bounded escalation, in order: (1) scale up to DESK_OVERLAP_MAX_SCALE_BOOST
 * over the head target, head top re-anchored at the SAME target (no title
 * impact); (2) shift the whole framing down, head top allowed to drop as
 * far as MIN_HEAD_TOP_FRAC; (3) throw — a source take that still can't
 * reach the desk after both has too little visible body below the crown
 * for this template's framing, full stop, and shipping the void anyway
 * would be strictly worse than failing the build with an actionable
 * message.
 */
const solveDeskOverlap = (
  headBBox: SubjectBBoxFrac | undefined,
  subjectBBox: SubjectBBoxFrac | undefined,
  target: PlatesManifest["reference"]["talkingHead"],
  deskEdgeFrac: number,
  width: number,
  height: number,
  blockId: string,
): DeskOverlapResult => {
  const baseTransform = computeSubjectTransform(headBBox, { topFrac: target.headTopFrac, heightFrac: target.headHeightFrac }, width, height);
  if (!headBBox || !subjectBBox) return { subjectTransform: baseTransform };

  const requiredBottomPx = (deskEdgeFrac + DESK_OVERLAP_MARGIN_FRAC) * height;
  const transformedBottomPx = (scale: number, yOffsetPx: number): number => subjectBBox.bottomFrac * height * scale + yOffsetPx;

  const baseBottomPx = transformedBottomPx(baseTransform.scale, baseTransform.yOffsetPx);
  if (baseBottomPx >= requiredBottomPx) return { subjectTransform: baseTransform };

  // Diagnostic only — which measurement is actually limiting this block,
  // logged so a real failure points at the right cause rather than
  // leaving "why" to be reverse-engineered from pixels later.
  const sourceLooksCropped = subjectBBox.bottomFrac > 0.97;
  console.log(
    `    desk-overlap: ${blockId} short by ${(requiredBottomPx - baseBottomPx).toFixed(1)}px at base framing` +
      (sourceLooksCropped ? " (source take's own bottom edge is already at the frame edge — likely a tight crop, not a matte defect)" : ""),
  );

  // (1) Scale up, head top re-anchored at the SAME target.
  const boostedScale = Math.min(baseTransform.scale * (1 + DESK_OVERLAP_MAX_SCALE_BOOST), 2.5);
  const boostedYOffset = target.headTopFrac * height - headBBox.topFrac * height * boostedScale;
  const boostedBottomPx = transformedBottomPx(boostedScale, boostedYOffset);
  if (boostedBottomPx >= requiredBottomPx) {
    console.log(`    desk-overlap: ${blockId} scaled ${baseTransform.scale.toFixed(3)} -> ${boostedScale.toFixed(3)} to reach the desk (head top unchanged)`);
    return { subjectTransform: { scale: boostedScale, xOffsetPx: baseTransform.xOffsetPx, yOffsetPx: Math.round(boostedYOffset) } };
  }

  // (2) Shift down, head top allowed to drop to MIN_HEAD_TOP_FRAC.
  const maxShiftPx = Math.max(0, (target.headTopFrac - MIN_HEAD_TOP_FRAC) * height);
  const shortfallPx = requiredBottomPx - boostedBottomPx;
  const shiftPx = Math.min(shortfallPx, maxShiftPx);
  const shiftedYOffset = boostedYOffset + shiftPx;
  const shiftedBottomPx = transformedBottomPx(boostedScale, shiftedYOffset);
  const actualHeadTopFrac = (shiftedYOffset + headBBox.topFrac * height * boostedScale) / height;

  if (shiftedBottomPx >= requiredBottomPx - 0.5) {
    console.log(
      `    desk-overlap: ${blockId} shifted down ${shiftPx.toFixed(1)}px (head top ${target.headTopFrac.toFixed(3)} -> ${actualHeadTopFrac.toFixed(3)}) to reach the desk`,
    );
    return {
      subjectTransform: { scale: boostedScale, xOffsetPx: baseTransform.xOffsetPx, yOffsetPx: Math.round(shiftedYOffset) },
      actualHeadTopFrac,
    };
  }

  // (3) Give up — the source take doesn't show enough body below the
  // crown for this template's framing, regardless of scale/shift.
  const requiredHeadHeights = (deskEdgeFrac + DESK_OVERLAP_MARGIN_FRAC - target.headTopFrac) / target.headHeightFrac;
  throw new Error(
    `replaceBackgrounds: block "${blockId}" — subject framing can't reach the desk edge even after scale-up and shift-down. ` +
      `Film from the top of your head down to at least your elbows/mid-torso (about ${requiredHeadHeights.toFixed(1)} head-heights below the crown).`,
  );
};

/**
 * The talking-head office composite's own calibrate callback (plan v6 §2):
 * on top of calibrateSubject's framing + whole-subject relight curve, this
 * also solves the four "reads as pasted" fixes — sharpness (2a), grain
 * (2b), color temperature (2c), and a directional key (2d) — every one of
 * them by MEASURING this job's own subject (2a, 2d) or the plate itself
 * (2b, 2c) and solving a filter to hit the reference's own fixed target
 * (PlatesManifestSchema's talkingHead.faceP97Target/plateSharpnessRatioMid/
 * grainStdTarget/roomWarmthTarget — see officeCompositeQC.ts), never a
 * constant applied blind. `officePlatePath`/`fps` are closed over rather
 * than threaded through compositeVideoOnBackdrop's calibrate signature,
 * since only this one caller needs them.
 */
const buildOfficeCompositeCalibrate = (
  target: PlatesManifest["reference"]["talkingHead"],
  deskEdgeFrac: number,
  officePlatePath: string,
  width: number,
  height: number,
  fps: number,
  blockId: string,
) => (framesDir: string, masksDir: string) => {
  const bbox = measureHeadBBox(masksDir, width, height);
  const subjectBBox = measureSubjectBBox(masksDir, width, height);
  const { subjectTransform, actualHeadTopFrac } = solveDeskOverlap(bbox, subjectBBox, target, deskEdgeFrac, width, height, blockId);

  const measured = measureSubjectLuma(framesDir, masksDir);
  let subjectFilter = measured ? solveSubjectRelight(measured, { p50: target.lumaP50, p95: target.lumaP95 }) : undefined;

  // 2d — directional key: probe what the whole-subject curve above
  // actually does to the FACE specifically (p97 of the hair/shadow-
  // excluding region) on ONE representative frame, then solve (iterating
  // — a one-shot target/measured ratio was tried and measured directly to
  // undershoot, see officeCompositeQC.ts's solveDirectionalKey doc
  // comment) a feathered gain centered on the head bbox that closes that
  // remaining gap — a flat lift would brighten hands/torso right along
  // with the face, which is exactly the defect this avoids.
  if (subjectFilter && bbox) {
    const sampleFrame = pickMiddleFrame(framesDir);
    if (sampleFrame) {
      const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-facep97-probe-"));
      try {
        const cutoutPath = path.join(probeDir, "cutout.png");
        execFileSync("ffmpeg", [
          "-y", "-v", "error",
          "-i", path.join(framesDir, sampleFrame), "-i", path.join(masksDir, sampleFrame),
          "-filter_complex", "[0][1]alphamerge",
          cutoutPath,
        ]);
        const relitPath = path.join(probeDir, "relit.png");
        applyFilterToImage(cutoutPath, subjectFilter, relitPath);
        const gainExpr = solveDirectionalKey(relitPath, path.join(masksDir, sampleFrame), bbox, width, height, target.faceP97Target);
        if (gainExpr) {
          subjectFilter = `${subjectFilter},format=rgba,geq=r='r(X\\,Y)*${gainExpr}':g='g(X\\,Y)*${gainExpr}':b='b(X\\,Y)*${gainExpr}':a='alpha(X\\,Y)'`;
        }
      } finally {
        fs.rmSync(probeDir, { recursive: true, force: true });
      }
    }
  }

  // 2a/2c/room-level — plate-side fixes (blur, then room-level gain, then
  // color); all solve against a canvas-sized copy of the raw plate (the
  // same resolution the composite actually uses). 2b (grain) is NOT
  // solved here — see replaceBackgrounds' own grain step, applied after
  // this composite AND applyLateralFalloff are both done, against the
  // ACTUAL final encode rather than a plate-only probe (a probe-solved
  // strength measured ~2x too weak once it went through the real
  // pipeline's own encode passes — see officeCompositeQC.ts's
  // solveGrainStrengthOnVideo doc comment).
  let backdropFilter: string | undefined;
  // Measured at the subject's ACTUAL on-canvas scale (subjectTransform's
  // own solved factor), not the pre-scale extracted frame — see
  // measureSubjectSharpness's own doc comment for why anchoring to the
  // wrong scale is exactly what made the sharpness ratio measure 1.05
  // against a 0.65 target despite solvePlateBlurSigma "succeeding".
  const subjectVariance = measureSubjectSharpness(framesDir, masksDir, width, height, 5, subjectTransform.scale);
  if (subjectVariance !== undefined && subjectVariance > 0) {
    const plateProbeDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-plate-solve-"));
    try {
      const sizedPlate = path.join(plateProbeDir, "plate.png");
      resizeCover(officePlatePath, width, height, sizedPlate);

      // maxSigma 4.0, not 2.0: re-anchoring the subject side (above)
      // raised the target variance the plate needs to soften BELOW,
      // since a properly-scaled subject reads sharper than the old
      // pre-scale measurement did — the old 2.0 cap was clipping the
      // solve short of the now-correct target on this job's own footage.
      const sigma = solvePlateBlurSigma(sizedPlate, width, height, subjectVariance, target.plateSharpnessRatioMid, 4.0);
      const blurredPlate = path.join(plateProbeDir, "plate-blur.png");
      if (sigma > 0.01) {
        applyFilterToImage(sizedPlate, `gblur=sigma=${sigma.toFixed(3)}`, blurredPlate);
      } else {
        fs.copyFileSync(sizedPlate, blurredPlate);
      }

      // Room-level gain: solved so the room reads faceEdgeRatioTarget-x
      // darker than THIS job's own measured face p97 (see
      // solveRoomLevelGain's own doc comment for why ratio-first, not an
      // absolute room-luma constant, is what generalizes across skin
      // tones). Runs on the BLURRED plate (after 2a), before warmth (2c) —
      // warmth is measured on the gained patch below so its own solve sees
      // the same brightness the final composite will.
      const gain = solveRoomLevelGain(blurredPlate, width, height, target.edgeFalloff, target.faceP97Target, target.faceEdgeRatioTarget);
      const gainedPlate = path.join(plateProbeDir, "plate-gain.png");
      if (Math.abs(gain - 1) > 0.01) {
        applyFilterToImage(blurredPlate, `format=yuv420p,lutyuv=y='clip(val*${gain.toFixed(4)}\\,0\\,255)',format=rgb24`, gainedPlate);
      } else {
        fs.copyFileSync(blurredPlate, gainedPlate);
      }

      const region = target.flatBackdropRegion;
      const cropW = Math.max(2, Math.round(width * (region.rightFrac - region.leftFrac)));
      const cropH = Math.max(2, Math.round(height * (region.bottomFrac - region.topFrac)));
      const cropX = Math.round(width * region.leftFrac);
      const cropY = Math.round(height * region.topFrac);
      const flatPatch = path.join(plateProbeDir, "flat-patch.png");
      applyFilterToImage(gainedPlate, `crop=${cropW}:${cropH}:${cropX}:${cropY}`, flatPatch);

      const filterStages: string[] = [];
      if (sigma > 0.01) filterStages.push(`gblur=sigma=${sigma.toFixed(3)}`);
      if (Math.abs(gain - 1) > 0.01) filterStages.push(`format=yuv420p,lutyuv=y='clip(val*${gain.toFixed(4)}\\,0\\,255)',format=rgba`);
      const { rs, bs } = solveWarmthFilter(flatPatch, cropW, cropH, target.roomWarmthTarget);
      if (Math.abs(rs) > 0.005 || Math.abs(bs) > 0.005) {
        filterStages.push(`colorbalance=rs=${rs.toFixed(4)}:rm=${rs.toFixed(4)}:rh=${rs.toFixed(4)}:bs=${bs.toFixed(4)}:bm=${bs.toFixed(4)}:bh=${bs.toFixed(4)}`);
      }
      if (filterStages.length > 0) backdropFilter = filterStages.join(",");
    } finally {
      fs.rmSync(plateProbeDir, { recursive: true, force: true });
    }
  }

  return { subjectTransform, subjectFilter, backdropFilter, actualHeadTopFrac };
};

/** Middle frame of a sampled sequence — a representative pose (not the
 *  first frame, which for a talking-head take is disproportionately
 *  likely to be a mid-blink or pre-settle frame). */
const pickMiddleFrame = (framesDir: string): string | undefined => {
  const files = fs.readdirSync(framesDir).filter((f) => f.endsWith(".png")).sort();
  if (files.length === 0) return undefined;
  return files[Math.floor(files.length / 2)];
};

export const replaceBackgrounds = async (
  format: Format,
  filled: FilledFormat,
  trims: TrimPoints,
  transcript: Transcript,
  matte: MatteArtifact,
): Promise<{ filled: FilledFormat; trims: TrimPoints; transcript: Transcript }> => {
  // Every `backgroundReplace` block MUST have a matte artifact entry — the
  // matte stage (pipeline/matte.ts) runs before this one specifically to
  // provide it. A punchInTailSec-only block (no backgroundReplace) has no
  // entry and doesn't need one — it cuts and processes its own subclip
  // exactly as before, matting never having anything to do with it.
  const matteByBlockId = new Map(matte.blocks.map((b) => [b.blockId, b]));

  const flagged = format.blocks.filter((b) => b.backgroundReplace || b.punchInTailSec !== undefined);
  const plateFlagged = format.blocks
    .map((b) => ({ block: b, composite: resolvePlateComposite(b) }))
    .filter((x): x is { block: Block; composite: { plate: string; treatment: "lit" | "silhouette" } } => x.composite !== undefined);
  if (flagged.length === 0 && plateFlagged.length === 0) return { filled, trims, transcript };

  const needsBackdrop = flagged.some((b) => b.backgroundReplace);
  const needsPlates = needsBackdrop || plateFlagged.length > 0;
  const manifest: PlatesManifest | undefined = needsPlates ? loadPlatesManifest(format.id) : undefined;

  let take: { absPath: string } | undefined;
  if (flagged.length > 0) {
    const takeSlot = format.speakingTakeSlot;
    if (!takeSlot) throw new Error("replaceBackgrounds: format has backgroundReplace/punchInTailSec blocks but no speakingTakeSlot");
    const bound = filled.bindings[takeSlot.name];
    if (bound?.type !== "file") {
      throw new Error(`replaceBackgrounds: speakingTakeSlot "${takeSlot.name}" is not bound to a file`);
    }
    take = bound;
  }

  const generatedDir = path.join(filled.jobDir, "generated");
  fs.mkdirSync(generatedDir, { recursive: true });

  const officePlatePath = needsBackdrop ? platePath(format.id, manifest!, "office-dark") : "";
  const officeForegroundPath = needsBackdrop ? deskForegroundPath(format.id, manifest!) : "";
  const officePlateSha = needsBackdrop ? manifest!.plates["office-dark"].sha256 : "";
  const talkingHeadTarget = manifest?.reference.talkingHead;

  const newBindings: Record<string, BoundAsset> = {};
  const newTrimBlocks = trims.blocks.map((b) => ({ ...b, takes: [...b.takes] }));
  const newTranscriptBlocks = transcript.blocks.map((b) => ({ ...b, takes: b.takes.map((take) => [...take]) }));
  // Only populated when solveDeskOverlap shifted a block's framing down
  // from the manifest's own headTopFrac target — assemble.ts's karaoke
  // title baseline must follow the head, or the title registers against
  // where the head WOULD have been rather than where it actually landed.
  const newKaraokeTitleBaselines: Record<string, number> = {};

  // `take` is guaranteed set here — this loop only runs when flagged.length
  // > 0, which is exactly the condition that assigned it above.
  const sharedTake = take;
  for (const block of flagged) {
    if (!sharedTake) throw new Error("replaceBackgrounds: unreachable — flagged block with no speakingTakeSlot binding");
    const trimEntry = newTrimBlocks.find((b) => b.blockId === block.id);
    if (!trimEntry) throw new Error(`replaceBackgrounds: no trim entry for block "${block.id}"`);
    const [span] = trimEntry.takes;

    const matteBlock: MatteBlock | undefined = block.backgroundReplace ? matteByBlockId.get(block.id) : undefined;
    if (block.backgroundReplace && !matteBlock) {
      throw new Error(`replaceBackgrounds: no matte artifact for backgroundReplace block "${block.id}" — run the matte stage first`);
    }

    const relPath = path.join("generated", `${block.videoSlot}-bg.mp4`);
    const absOutPath = path.join(filled.jobDir, relPath);
    const hash = requestHash({
      takeAbsPath: sharedTake.absPath,
      srcInSec: span.srcInSec,
      srcOutSec: span.srcOutSec,
      backgroundReplace: block.backgroundReplace,
      officePlateSha: block.backgroundReplace ? officePlateSha : undefined,
      // Stamped in so a changed matte (different engine, footage, or
      // downsample ratio — anything that changes the masks themselves)
      // invalidates this cache even when takeAbsPath/span are unchanged,
      // and so the flattened composite and the fg-alpha layer built from
      // it are invalidated TOGETHER, never independently.
      masksHash: matteBlock?.masksHash,
      punchInTailSec: block.punchInTailSec,
      fps: format.fps,
      width: format.width,
      height: format.height,
    });

    withCache(absOutPath, hash, () => {
      // A backgroundReplace block's subclip/masks come from the matte
      // stage (already cut and matted, RVM or Vision+temporal-median —
      // see pipeline/matte.ts), persisted and reused rather than cut
      // again here. A punchInTailSec-only block (no backgroundReplace)
      // has no matte entry and cuts its own subclip exactly as before.
      const subClipPath = matteBlock
        ? path.join(filled.jobDir, matteBlock.subclipPath)
        : path.join(generatedDir, `${block.videoSlot}-subclip.mp4`);
      if (!matteBlock) {
        execFileSync("ffmpeg", [
          "-y", "-v", "error",
          "-ss", String(span.srcInSec),
          "-i", sharedTake.absPath,
          "-t", String(span.srcOutSec - span.srcInSec),
          "-c:v", "libx264", "-c:a", "aac",
          subClipPath,
        ]);
      }
      const precomputedMasksDir = matteBlock ? path.join(filled.jobDir, matteBlock.masksDir) : undefined;

      // backgroundReplace, punchInTailSec, or both — either way `current`
      // ends up pointing at whatever the block's video should be before
      // the final rename into absOutPath. `currentFg` tracks the matching
      // fg-alpha layer the SAME way, staying in lockstep through
      // punchInTailSec too (see the alpha-preserving applyPunchInTail
      // call below) — undefined for any block that isn't captionVariant
      // "karaokeTitle" (no fg layer to track at all).
      let current = subClipPath;
      let currentFg: string | undefined;
      if (block.backgroundReplace) {
        const compositedPath = path.join(generatedDir, `${block.videoSlot}-composited.mp4`);
        // Captured here so the fg-alpha layer below (built only for
        // karaokeTitle blocks) reuses the SAME transform/relight this
        // composite used, rather than re-deriving its own — the two
        // layers must line up pixel-for-pixel or the subject would visibly
        // jump between the flattened composite and the fg layer sitting
        // on top of it.
        let capturedTransform: SubjectTransform | undefined;
        let capturedFilter: string | undefined;
        let capturedActualHeadTopFrac: number | undefined;
        compositeVideoOnBackdrop({
          subjectVideoPath: current,
          backdropPath: officePlatePath,
          foregroundPath: officeForegroundPath,
          outPath: compositedPath,
          width: format.width,
          height: format.height,
          fps: format.fps,
          precomputedMasksDir,
          calibrate: (framesDir, masksDir) => {
            const result = buildOfficeCompositeCalibrate(
              talkingHeadTarget!,
              manifest!.deskEdgeFrac,
              officePlatePath,
              format.width,
              format.height,
              format.fps,
              block.id,
            )(framesDir, masksDir);
            capturedTransform = result.subjectTransform;
            capturedFilter = result.subjectFilter;
            capturedActualHeadTopFrac = result.actualHeadTopFrac;
            return result;
          },
        });
        if (capturedActualHeadTopFrac !== undefined) {
          newKaraokeTitleBaselines[block.id] = capturedActualHeadTopFrac;
        }
        // Runs on the flattened composite (subject + desk foreground both
        // already baked in) — see matte.ts's applyLateralFalloff doc
        // comment for why this is a separate pass rather than folded into
        // compositeVideoOnBackdrop itself.
        const falloffPath = path.join(generatedDir, `${block.videoSlot}-falloff.mp4`);
        applyLateralFalloff(compositedPath, falloffPath, talkingHeadTarget!.edgeFalloff);
        fs.rmSync(compositedPath, { force: true });
        current = falloffPath;

        // 2b (grain), last: solved against THIS clip — the actual,
        // already fully-composited-and-recompressed output — not a
        // synthetic probe (see officeCompositeQC.ts's
        // solveGrainStrengthOnVideo doc comment for why an isolated probe
        // measurably undershoots once real encoder rate-control and a
        // second recompression pass are both in play). Applied whole-
        // frame, not backdrop-only: real camera grain isn't selective
        // either. This clip is NOT the last encode in the chain — Remotion
        // takes it as a source asset and re-encodes it again into the
        // final render (remotion.config.ts sets no explicit codec/crf, so
        // that's h264/CRF 18/yuv420p) — renderReencode mirrors a second
        // libx264 pass in the probe itself, which measurably barely
        // attenuates grain on its own (tested directly: 3.04 -> 3.03).
        // GRAIN_RENDER_LOSS_CORRECTION is the REMAINING gap: a full real
        // render of this job measured grain 1.7-2.4 against a 3.4 target
        // solved via the double-libx264-only probe — Remotion's actual
        // frame pipeline (jpeg-format frames, per remotion.config.ts's
        // own setVideoImageFormat("jpeg")) evidently attenuates grain
        // further than a plain second h264 pass alone reproduces, and a
        // direct jpeg-round-trip simulation (mjpeg encode/decode at a
        // reasonable quality) ALSO didn't reproduce a comparable drop in
        // isolated testing — so whatever the exact mechanism, this is an
        // empirical correction against the measured real-render gap
        // (≈3.4/2.1), not a modeled one; per this rework's own plan, "at
        // most one corrective re-solve iteration using the measured
        // final render" — this IS that one iteration, verified against a
        // full pipeline run after applying it (see Phase 6 verification).
        const GRAIN_RENDER_LOSS_CORRECTION = 1.6;
        const grainStrength = solveGrainStrengthOnVideo(
          falloffPath,
          Math.min(0.3, (span.srcOutSec - span.srcInSec) / 3),
          talkingHeadTarget!.flatBackdropRegion,
          format.width,
          format.height,
          format.fps,
          talkingHeadTarget!.grainStdTarget * GRAIN_RENDER_LOSS_CORRECTION,
          60,
          8,
          { crf: 18 },
        );
        if (grainStrength > 0) {
          const grainedPath = path.join(generatedDir, `${block.videoSlot}-grained.mp4`);
          execFileSync("ffmpeg", [
            "-y", "-v", "error",
            "-i", falloffPath,
            "-vf", `noise=alls=${grainStrength}:allf=t+u`,
            "-c:a", "copy",
            grainedPath,
          ]);
          fs.rmSync(falloffPath, { force: true });
          current = grainedPath;
        }

        // karaokeTitle blocks need the title to sit BEHIND the head (see
        // schemas.ts's captionVariant doc comment) — build the matching
        // fg-alpha layer (subject + desk foreground, transparent
        // elsewhere) here, right where the flattened composite's own
        // transform/filter are already in hand. Bound to a synthetic
        // "<videoSlot>-fg" key below, mirroring ecuCutaway's own
        // synthetic-slot pattern — assemble.ts looks it up the same way.
        if (block.captionVariant === "karaokeTitle") {
          const fgPath = path.join(generatedDir, `${block.videoSlot}-fg.mov`);
          compositeSubjectAlphaVideo({
            subjectVideoPath: subClipPath,
            foregroundPath: officeForegroundPath,
            outPath: fgPath,
            width: format.width,
            height: format.height,
            fps: format.fps,
            subjectTransform: capturedTransform,
            subjectFilter: capturedFilter,
            precomputedMasksDir,
            // Same falloff/grain the flattened bg layer got (edgeFalloff
            // applied above via applyLateralFalloff; grainStrength solved
            // just above) — this fg layer previously skipped both, which
            // is why its own desk strip measured ~1.7x brighter than the
            // bg layer's at the same coordinates.
            edgeFalloff: talkingHeadTarget!.edgeFalloff,
            grainStrength,
          });
          currentFg = fgPath;
        }
      }
      if (block.punchInTailSec !== undefined) {
        const punchedPath = path.join(generatedDir, `${block.videoSlot}-punchin.mp4`);
        applyPunchInTail(current, punchedPath, {
          durationSec: span.srcOutSec - span.srcInSec,
          tailSec: block.punchInTailSec,
          width: format.width,
          height: format.height,
        });
        if (current !== subClipPath) fs.rmSync(current, { force: true });
        current = punchedPath;

        // Keep the fg layer moving in lockstep with the flattened
        // composite's own punch-in, or the two layers shear apart during
        // the tail (see the alpha-preserving applyPunchInTail doc comment).
        if (currentFg) {
          const punchedFgPath = path.join(generatedDir, `${block.videoSlot}-fg-punchin.mov`);
          applyPunchInTail(currentFg, punchedFgPath, {
            durationSec: span.srcOutSec - span.srcInSec,
            tailSec: block.punchInTailSec,
            width: format.width,
            height: format.height,
            alpha: true,
          });
          fs.rmSync(currentFg, { force: true });
          currentFg = punchedFgPath;
        }
      }
      fs.renameSync(current, absOutPath);
      // Only delete a subclip THIS function cut itself (punchInTailSec-
      // only blocks) — a backgroundReplace block's subclip is owned and
      // persisted by the matte stage (pipeline/matte.ts), reused across
      // runs, and must survive this function returning.
      if (!matteBlock) fs.rmSync(subClipPath, { force: true });
      if (currentFg) {
        const fgOutPath = path.join(generatedDir, `${block.videoSlot}-fg.mov`);
        if (currentFg !== fgOutPath) fs.renameSync(currentFg, fgOutPath);
      }
    });

    const probed = probeFile(absOutPath);
    newBindings[block.videoSlot] = {
      type: "file",
      path: relPath,
      absPath: absOutPath,
      mediaType: "video",
      durationSec: probed.durationSec,
      width: probed.width,
      height: probed.height,
      hasAudio: probed.hasAudio,
    };
    if (block.backgroundReplace && block.captionVariant === "karaokeTitle") {
      const fgRelPath = path.join("generated", `${block.videoSlot}-fg.mov`);
      const fgAbsPath = path.join(filled.jobDir, fgRelPath);
      const fgProbed = probeFile(fgAbsPath);
      newBindings[`${block.videoSlot}-fg`] = {
        type: "file",
        path: fgRelPath,
        absPath: fgAbsPath,
        mediaType: "video",
        durationSec: fgProbed.durationSec,
        width: fgProbed.width,
        height: fgProbed.height,
        hasAudio: false,
      };
    }
    // The new file starts at 0 and IS this block's span, unlike before
    // where it was a sub-span inside the shared take — rebase this
    // block's transcript words the same way (still take-relative until
    // now), or resolveRoles/assemble compute anchor spans against the
    // wrong origin (see this file's doc comment).
    const takeRelativeSrcInSec = span.srcInSec;
    trimEntry.takes = [{ srcInSec: 0, srcOutSec: probed.durationSec ?? span.srcOutSec - span.srcInSec }];

    const transcriptEntry = newTranscriptBlocks.find((b) => b.blockId === block.id);
    if (transcriptEntry) {
      transcriptEntry.takes = transcriptEntry.takes.map((take) =>
        take.map((w) => ({
          ...w,
          startSec: w.startSec - takeRelativeSrcInSec,
          endSec: w.endSec - takeRelativeSrcInSec,
        })),
      );
    }
  }

  // plateComposite / silhouette: broll blocks, their own clip (no shared
  // take), each composited onto ITS OWN named plate (possibly different
  // plates per block, unlike the shared office backdrop above).
  if (plateFlagged.length > 0) {
    const vignettePath = path.join(generatedDir, "silhouette-vignette-backdrop.png");
    if (!fs.existsSync(vignettePath)) generateVignetteBackdrop(format.width, format.height, vignettePath);
    const endCardTarget = manifest!.reference.endCard;

    for (const { block, composite } of plateFlagged) {
      const bound = filled.bindings[block.videoSlot];
      if (bound?.type !== "file" || bound.durationSec === undefined) {
        throw new Error(`replaceBackgrounds: plate-composited block "${block.id}" videoSlot "${block.videoSlot}" is not bound to a file with a known duration`);
      }
      const targetDurationSec = Math.min(block.brollDurationSec ?? bound.durationSec, bound.durationSec);
      const plateAbsPath = platePath(format.id, manifest!, composite.plate);
      const plateSha = manifest!.plates[composite.plate]?.sha256 ?? composite.plate;

      const relPath = path.join("generated", `${block.videoSlot}-plate.mp4`);
      const absOutPath = path.join(filled.jobDir, relPath);
      const hash = requestHash({
        srcAbsPath: bound.absPath,
        targetDurationSec,
        plateSha,
        treatment: composite.treatment,
        width: format.width,
        height: format.height,
        fps: format.fps,
      });

      withCache(absOutPath, hash, () => {
        // Center-anchored, not tail-anchored: a "walk in, hold, walk out"
        // take (what the format's own instructions describe, and what
        // this job's actual footage does) has its held pose in the
        // MIDDLE, not the end — the last few seconds are frequently the
        // subject already exiting frame. Tail-anchoring shipped as
        // exactly that bug once: matte coverage measured 103 (frame 1)
        // dropping to 0 (frame 30 on) because the "tail" was mid-exit.
        const windowStartSec = Math.max(0, (bound.durationSec! - targetDurationSec) / 2);
        const tailClipPath = path.join(generatedDir, `${block.videoSlot}-tail.mp4`);
        execFileSync("ffmpeg", [
          "-y", "-v", "error",
          "-ss", String(windowStartSec),
          "-i", bound.absPath,
          "-t", String(targetDurationSec),
          "-c:v", "libx264", "-c:a", "aac",
          tailClipPath,
        ]);
        compositeVideoOnBackdrop({
          subjectVideoPath: tailClipPath,
          backdropPath: plateAbsPath,
          outPath: absOutPath,
          width: format.width,
          height: format.height,
          fps: format.fps,
          silhouette: composite.treatment === "silhouette",
          calibrate: calibrateSubject(
            { topFrac: endCardTarget.subjectTopFrac, heightFrac: endCardTarget.subjectHeightFrac },
            composite.treatment === "lit" ? { p50: endCardTarget.lumaP50, p95: endCardTarget.lumaP95 } : undefined,
            format.width,
            format.height,
          ),
        });
        fs.rmSync(tailClipPath, { force: true });
      });

      const probed = probeFile(absOutPath);
      newBindings[block.videoSlot] = {
        type: "file",
        path: relPath,
        absPath: absOutPath,
        mediaType: "video",
        durationSec: probed.durationSec,
        width: probed.width,
        height: probed.height,
        hasAudio: probed.hasAudio,
      };
      const trimEntry = newTrimBlocks.find((b) => b.blockId === block.id);
      if (trimEntry) {
        trimEntry.takes = [{ srcInSec: 0, srcOutSec: probed.durationSec ?? targetDurationSec }];
      }
    }
  }

  // ecuCutaway: runs LAST, after every other flag above, so it always
  // crops from each block's FINAL processed clip (background-replaced if
  // flagged, as-filmed otherwise) — never the pre-processing original.
  // Bound to a synthetic "<videoSlot>-ecu" slot; assemble.ts turns this
  // config directly into a CutawayOverlay event, so a format author only
  // ever writes the one `ecuCutaway` field, no separate slot/event
  // authoring the way backgroundReplace/silhouette still require.
  for (const block of format.blocks) {
    if (!block.ecuCutaway) continue;
    const bound = { ...filled.bindings, ...newBindings }[block.videoSlot];
    if (bound?.type !== "file") {
      throw new Error(`replaceBackgrounds: ecuCutaway block "${block.id}" videoSlot "${block.videoSlot}" is not bound to a file`);
    }

    const ecuSlotName = `${block.videoSlot}-ecu`;
    const relPath = path.join("generated", `${ecuSlotName}.mp4`);
    const absOutPath = path.join(filled.jobDir, relPath);
    const hash = requestHash({ srcAbsPath: bound.absPath, ecuCutaway: block.ecuCutaway, width: format.width, height: format.height });

    withCache(absOutPath, hash, () => {
      extractCloseUpCutaway(bound.absPath, absOutPath, {
        atSec: block.ecuCutaway!.atSec,
        durationSec: block.ecuCutaway!.durationSec,
        width: format.width,
        height: format.height,
      });
    });

    const probed = probeFile(absOutPath);
    newBindings[ecuSlotName] = {
      type: "file",
      path: relPath,
      absPath: absOutPath,
      mediaType: "video",
      durationSec: probed.durationSec,
      width: probed.width,
      height: probed.height,
      hasAudio: false,
    };
  }

  return {
    filled: {
      ...filled,
      bindings: { ...filled.bindings, ...newBindings },
      karaokeTitleBaselines:
        Object.keys(newKaraokeTitleBaselines).length > 0
          ? { ...filled.karaokeTitleBaselines, ...newKaraokeTitleBaselines }
          : filled.karaokeTitleBaselines,
    },
    trims: { ...trims, blocks: newTrimBlocks },
    transcript: { ...transcript, blocks: newTranscriptBlocks },
  };
};

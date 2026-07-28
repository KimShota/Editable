import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { probeFile } from "./intake";
import { compositeVideoOnBackdrop, generateVignetteBackdrop } from "./generation/matte";
import { deskForegroundPath, loadPlatesManifest, platePath } from "./generation/plates";
import { measureSubjectBBox, computeSubjectTransform } from "./generation/subjectFit";
import { measureSubjectLuma, solveSubjectRelight } from "./generation/relight";
import { applyPunchInTail, extractCloseUpCutaway } from "./videoEffects";
import { PIPELINE_VERSION } from "./pipelineVersion";
import { Block, BoundAsset, FilledFormat, Format, PlatesManifest, Transcript, TrimPoints } from "./types";

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
 *  talking-head office composite and the broll plate composites below. */
const calibrateSubject = (
  target: { topFrac: number; heightFrac: number },
  lumaTarget: { p50: number; p95: number } | undefined,
  width: number,
  height: number,
) => (framesDir: string, masksDir: string) => {
  const bbox = measureSubjectBBox(masksDir, width, height);
  const subjectTransform = computeSubjectTransform(bbox, target, width, height);
  if (!lumaTarget) return { subjectTransform };
  const measured = measureSubjectLuma(framesDir, masksDir);
  const subjectFilter = measured ? solveSubjectRelight(measured, lumaTarget) : undefined;
  return { subjectTransform, subjectFilter };
};

export const replaceBackgrounds = async (
  format: Format,
  filled: FilledFormat,
  trims: TrimPoints,
  transcript: Transcript,
): Promise<{ filled: FilledFormat; trims: TrimPoints; transcript: Transcript }> => {
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

  // `take` is guaranteed set here — this loop only runs when flagged.length
  // > 0, which is exactly the condition that assigned it above.
  const sharedTake = take;
  for (const block of flagged) {
    if (!sharedTake) throw new Error("replaceBackgrounds: unreachable — flagged block with no speakingTakeSlot binding");
    const trimEntry = newTrimBlocks.find((b) => b.blockId === block.id);
    if (!trimEntry) throw new Error(`replaceBackgrounds: no trim entry for block "${block.id}"`);
    const [span] = trimEntry.takes;

    const relPath = path.join("generated", `${block.videoSlot}-bg.mp4`);
    const absOutPath = path.join(filled.jobDir, relPath);
    const hash = requestHash({
      takeAbsPath: sharedTake.absPath,
      srcInSec: span.srcInSec,
      srcOutSec: span.srcOutSec,
      backgroundReplace: block.backgroundReplace,
      officePlateSha: block.backgroundReplace ? officePlateSha : undefined,
      punchInTailSec: block.punchInTailSec,
      fps: format.fps,
      width: format.width,
      height: format.height,
    });

    withCache(absOutPath, hash, () => {
      const subClipPath = path.join(generatedDir, `${block.videoSlot}-subclip.mp4`);
      execFileSync("ffmpeg", [
        "-y", "-v", "error",
        "-ss", String(span.srcInSec),
        "-i", sharedTake.absPath,
        "-t", String(span.srcOutSec - span.srcInSec),
        "-c:v", "libx264", "-c:a", "aac",
        subClipPath,
      ]);

      // backgroundReplace, punchInTailSec, or both — either way `current`
      // ends up pointing at whatever the block's video should be before
      // the final rename into absOutPath.
      let current = subClipPath;
      if (block.backgroundReplace) {
        const compositedPath = path.join(generatedDir, `${block.videoSlot}-composited.mp4`);
        compositeVideoOnBackdrop({
          subjectVideoPath: current,
          backdropPath: officePlatePath,
          foregroundPath: officeForegroundPath,
          outPath: compositedPath,
          width: format.width,
          height: format.height,
          fps: format.fps,
          calibrate: calibrateSubject(
            { topFrac: talkingHeadTarget!.headTopFrac, heightFrac: talkingHeadTarget!.headHeightFrac },
            { p50: talkingHeadTarget!.lumaP50, p95: talkingHeadTarget!.lumaP95 },
            format.width,
            format.height,
          ),
        });
        current = compositedPath;
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
      }
      fs.renameSync(current, absOutPath);
      fs.rmSync(subClipPath, { force: true });
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
    filled: { ...filled, bindings: { ...filled.bindings, ...newBindings } },
    trims: { ...trims, blocks: newTrimBlocks },
    transcript: { ...transcript, blocks: newTranscriptBlocks },
  };
};

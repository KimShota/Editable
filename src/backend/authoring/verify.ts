import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { probeFile } from "../pipeline/intake";
import { resolveRoles } from "../pipeline/resolveRoles";
import { assemble } from "../pipeline/assemble";
import { render, stageAssets } from "../pipeline/render";
import { deriveTranscriptAndTrim, splitTake } from "../pipeline/splitTake";
import { clamp } from "../pipeline/timing";
import { authoringDir } from "../pipeline/paths";
import { BoundAsset, FilledFormat, Format } from "../pipeline/types";
import { measureSsim } from "./ssim";
import { Analysis, Draft, VerifyBlockResult, VerifyResult, VerifyWindowResult } from "./types";

/**
 * Module A4 — Verify (self-verification).
 *
 * Proves a synthesized format's fidelity to its own reference reel
 * automatically, instead of relying on a human to eyeball it: treats the
 * reference clip as if it were "the user's own footage" (via splitTake.ts —
 * the same mechanism a real speakingTakeSlot job already uses to slice one
 * continuous take into per-block spans), runs it through the REAL
 * assemble/render pipeline, and frame-compares the result against the
 * reference itself via ffmpeg's ssim filter.
 *
 * Two-pass assemble is necessary because resolveComponentParams (inside
 * assemble.ts) silently DROPS any overlay whose slot isn't bound — so pass
 * 1 binds every slot to a throwaway placeholder (video slots to a real cut
 * of the reference, since that's free and gives real timing; everything
 * else to a generated stand-in) purely to discover each overlay's real
 * resolved box/timing/states, then crops the ACTUAL reference pixels at
 * each image overlay's own settled reveal moment and re-assembles with
 * those real crops bound for the real render.
 *
 * v1 scope (deliberately, see the design plan): only "voice" blocks that
 * splitTake actually finds in the reference are self-verified; "broll"
 * blocks and any block splitTake couldn't locate are skipped with a
 * recorded reason, not silently ignored. Audio/caption fidelity isn't
 * measured — only image/video overlay geometry+timing, the exact gap this
 * whole effort exists to close. No auto-repair loop yet: this is a
 * measure-and-persist stage: a human sees the score before saving a draft,
 * they don't need to manually reposition/resize/retime anything.
 */

/** Past this margin past a state's own trigger, its entrance/reveal
 *  animation has settled — cropping any earlier would catch a mid-fade or
 *  mid-blur frame instead of the element's true final look. */
const SETTLE_MARGIN_SEC = 0.15;

const PLACEHOLDER_SIZE = 64;

const boundFileFrom = (label: string, absPath: string): BoundAsset => {
  const probed = probeFile(absPath);
  return {
    type: "file",
    path: label,
    absPath,
    mediaType: probed.mediaType,
    durationSec: probed.durationSec,
    width: probed.width,
    height: probed.height,
    hasAudio: probed.hasAudio,
  };
};

const makePlaceholderImage = (outPath: string): void => {
  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x808080:s=${PLACEHOLDER_SIZE}x${PLACEHOLDER_SIZE}`,
    "-frames:v",
    "1",
    outPath,
  ]);
};

const makePlaceholderVideo = (outPath: string): void => {
  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x808080:s=${PLACEHOLDER_SIZE}x${PLACEHOLDER_SIZE}:d=1`,
    "-c:v",
    "libx264",
    outPath,
  ]);
};

const cutClip = (sourcePath: string, srcInSec: number, srcOutSec: number, outPath: string): void => {
  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-ss",
    srcInSec.toFixed(3),
    "-t",
    (srcOutSec - srcInSec).toFixed(3),
    "-i",
    sourcePath,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    outPath,
  ]);
};

/** Every slot a self-fillable block (or the format's sharedSlots) declares,
 *  bound to SOMETHING so pass 1's assemble() never drops an event for lack
 *  of a binding: the block's own main clip gets a real cut of the
 *  reference (free, and gives real timing to resolve events against);
 *  every other slot gets a throwaway generated stand-in. Audio slots are
 *  left UNBOUND on purpose — sfx/music fidelity is out of v1 scope, and an
 *  unbound optional/required audio slot just makes assemble.ts skip that
 *  one sfx event, which doesn't affect the image/video geometry this stage
 *  actually measures. */
const buildPlaceholderBindings = (
  verifyFormat: Format,
  splitBlocks: Map<string, { srcInSec: number; srcOutSec: number }>,
  sourcePath: string,
  workDir: string,
): Record<string, BoundAsset> => {
  const cutsDir = path.join(workDir, "cuts");
  const placeholdersDir = path.join(workDir, "placeholders");
  fs.mkdirSync(cutsDir, { recursive: true });
  fs.mkdirSync(placeholdersDir, { recursive: true });

  const bindings: Record<string, BoundAsset> = {};
  let placeholderImagePath: string | undefined;
  let placeholderVideoPath: string | undefined;

  const bindSlot = (name: string, mediaType: "video" | "image" | "audio" | "text"): void => {
    if (bindings[name]) return;
    if (mediaType === "audio") return; // left unbound, see doc comment above
    if (mediaType === "text") {
      bindings[name] = { type: "text", text: "Sample" };
      return;
    }
    if (mediaType === "image") {
      if (!placeholderImagePath) {
        placeholderImagePath = path.join(placeholdersDir, "image.png");
        makePlaceholderImage(placeholderImagePath);
      }
      bindings[name] = boundFileFrom(name, placeholderImagePath);
      return;
    }
    if (!placeholderVideoPath) {
      placeholderVideoPath = path.join(placeholdersDir, "video.mp4");
      makePlaceholderVideo(placeholderVideoPath);
    }
    bindings[name] = boundFileFrom(name, placeholderVideoPath);
  };

  for (const block of verifyFormat.blocks) {
    const span = splitBlocks.get(block.id);
    if (span) {
      const cutPath = path.join(cutsDir, `${block.id}.mp4`);
      cutClip(sourcePath, span.srcInSec, span.srcOutSec, cutPath);
      bindings[block.videoSlot] = boundFileFrom(block.videoSlot, cutPath);
    }
    for (const slot of block.slots) {
      if (slot.name === block.videoSlot) continue;
      bindSlot(slot.name, slot.mediaType);
    }
  }
  for (const slot of verifyFormat.sharedSlots) {
    bindSlot(slot.name, slot.mediaType);
  }

  return bindings;
};

/**
 * Never throws — verify is an advisory signal alongside a draft that
 * otherwise already synthesized successfully, so a tooling failure here
 * (ffmpeg, whisper, a malformed reference clip) degrades to an empty/
 * partial score with the failure recorded in `diagnostics`, the same
 * "never hard-fail, just degrade" shape as every anchor-resolution fallback
 * elsewhere in this pipeline — it must NOT mask an otherwise-good draft.json
 * as an authoring error.
 */
export const verify = async (
  draftId: string,
  draft: Draft,
  analysis: Analysis,
  sourcePath: string,
): Promise<VerifyResult> => {
  try {
    return await runVerify(draftId, draft, analysis, sourcePath);
  } catch (err) {
    return {
      draftId,
      createdAt: new Date().toISOString(),
      blocks: [],
      windows: [],
      diagnostics: [`verify: failed unexpectedly — ${(err as Error).message}`],
    };
  }
};

const runVerify = async (
  draftId: string,
  draft: Draft,
  analysis: Analysis,
  sourcePath: string,
): Promise<VerifyResult> => {
  const dir = authoringDir(draftId);
  const workDir = path.join(dir, "verify");
  fs.mkdirSync(workDir, { recursive: true });

  const blockResults: VerifyBlockResult[] = [];
  const diagnostics: string[] = [];

  const format = draft.format;
  // Self-verification treats the WHOLE reference clip as if it were one
  // continuous take covering every non-optional voice block — unlike a
  // real job, there's no FilledFormat with per-block bindings to check
  // coverage against (see splitTake.ts's isTakeCovered), so every such
  // block is passed directly instead of letting production code narrow it.
  const voiceBlocks = format.blocks.filter((b) => b.kind === "voice" && !b.optional);
  const split = splitTake(format, voiceBlocks, sourcePath, analysis.durationSec);

  for (const block of format.blocks) {
    if (block.kind === "broll") {
      blockResults.push({ blockId: block.id, skipped: "broll blocks aren't self-verified in v1 (no anchor to cut a span from)" });
    }
  }

  const usableSplits = split.blocks.filter((b) => {
    if (b.confidence <= 0) {
      blockResults.push({
        blockId: b.blockId,
        skipped: "no matching anchor found in the reference — can't self-verify a beat the source doesn't actually contain",
      });
      return false;
    }
    return true;
  });

  if (usableSplits.length === 0) {
    return {
      draftId,
      createdAt: new Date().toISOString(),
      blocks: blockResults,
      windows: [],
      diagnostics: ["verify: nothing to self-verify — no voice block's marker phrase was found in the reference"],
    };
  }

  const usableBlockIds = new Set(usableSplits.map((b) => b.blockId));
  const verifyFormat: Format = { ...format, blocks: format.blocks.filter((b) => usableBlockIds.has(b.id)) };
  const splitBlocks = new Map(usableSplits.map((b) => [b.blockId, { srcInSec: b.srcInSec, srcOutSec: b.srcOutSec }]));

  const placeholderBindings = buildPlaceholderBindings(verifyFormat, splitBlocks, sourcePath, workDir);
  const filledPlaceholder: FilledFormat = {
    jobId: `verify-${draftId}`,
    jobDir: workDir,
    formatId: format.id,
    bindings: placeholderBindings,
    lexicon: [],
  };

  const { transcript, trim: trims } = deriveTranscriptAndTrim(verifyFormat, filledPlaceholder, split);
  const resolved = await resolveRoles(verifyFormat, transcript, trims, "auto");

  const edlPass1 = assemble(verifyFormat, filledPlaceholder, transcript, trims, resolved);

  // Crop the reference's OWN pixels at each image overlay's settled reveal
  // moment, using ITS OWN resolved box (whether authored via "layout" or
  // assemble.ts's own default) — converted from frame fractions into
  // source-video pixels via the format's own width/height, which
  // synthesize.ts is instructed to match to the source exactly.
  const cropsDir = path.join(workDir, "crops");
  fs.mkdirSync(cropsDir, { recursive: true });
  const imageCrops = new Map<string, string>();

  for (const block of verifyFormat.blocks) {
    const span = splitBlocks.get(block.id);
    if (!span) continue;
    const videoSpans = edlPass1.video.filter((v) => v.blockId === block.id);
    if (videoSpans.length === 0) continue;
    const blockTlInSec = Math.min(...videoSpans.map((v) => v.tlInSec));

    for (const event of block.events) {
      if (event.kind !== "overlay" || event.component.component !== "ImageOverlay") continue;
      const imageSlotName = event.component.params.imageSlot;
      if (typeof imageSlotName !== "string") continue;
      const overlay = edlPass1.overlays.find((o) => o.id === event.id);
      if (!overlay) continue; // dropped in pass 1 despite the placeholder — unexpected, leave unset

      const lastState = overlay.states.length > 0 ? overlay.states[overlay.states.length - 1] : undefined;
      const localRevealSec = (lastState?.atSec ?? overlay.tlInSec) - blockTlInSec + SETTLE_MARGIN_SEC;
      const sourceAtSec = clamp(span.srcInSec + localRevealSec, span.srcInSec, Math.max(span.srcInSec, span.srcOutSec - 0.05));

      const px = {
        x: Math.max(0, Math.round(overlay.x * verifyFormat.width)),
        y: Math.max(0, Math.round(overlay.y * verifyFormat.height)),
        w: Math.max(2, Math.round(overlay.width * verifyFormat.width)),
        h: Math.max(2, Math.round(overlay.height * verifyFormat.height)),
      };
      const cropPath = path.join(cropsDir, `${event.id}.png`);
      try {
        execFileSync("ffmpeg", [
          "-y",
          "-v",
          "error",
          "-ss",
          sourceAtSec.toFixed(3),
          "-i",
          sourcePath,
          "-frames:v",
          "1",
          "-vf",
          `crop=${px.w}:${px.h}:${px.x}:${px.y}`,
          cropPath,
        ]);
        imageCrops.set(imageSlotName, cropPath);
      } catch (err) {
        diagnostics.push(`verify: failed to crop reference pixels for "${event.id}" — ${(err as Error).message}`);
      }
    }
  }

  const realBindings: Record<string, BoundAsset> = { ...placeholderBindings };
  for (const [slotName, cropPath] of imageCrops) {
    realBindings[slotName] = boundFileFrom(slotName, cropPath);
  }
  const filledReal: FilledFormat = { ...filledPlaceholder, bindings: realBindings };

  const edlFinal = assemble(verifyFormat, filledReal, transcript, trims, resolved);
  stageAssets(edlFinal);
  const outPath = render(edlFinal, workDir);

  for (const block of verifyFormat.blocks) {
    const span = splitBlocks.get(block.id);
    if (!span) continue;
    const videoSpans = edlPass1.video.filter((v) => v.blockId === block.id);
    if (videoSpans.length === 0) {
      blockResults.push({ blockId: block.id, skipped: "no rendered span found for this block" });
      continue;
    }
    const tlInSec = Math.min(...videoSpans.map((v) => v.tlInSec));
    const tlOutSec = Math.max(...videoSpans.map((v) => v.tlOutSec));
    const durationSec = Math.min(tlOutSec - tlInSec, span.srcOutSec - span.srcInSec);
    if (durationSec <= 0.1) {
      blockResults.push({ blockId: block.id, skipped: "span too short to measure" });
      continue;
    }
    try {
      const ssim = measureSsim(outPath, tlInSec, sourcePath, span.srcInSec, durationSec, verifyFormat.width, verifyFormat.height, verifyFormat.fps);
      blockResults.push({ blockId: block.id, ssim });
    } catch (err) {
      diagnostics.push(`verify: ssim measurement failed for block "${block.id}" — ${(err as Error).message}`);
      blockResults.push({ blockId: block.id, skipped: `ssim measurement failed: ${(err as Error).message}` });
    }
  }

  const measuredScores = blockResults.map((b) => b.ssim).filter((s): s is number => typeof s === "number");
  const overallScore = measuredScores.length > 0 ? Math.min(...measuredScores) : undefined;

  // Per-animation-window scoring (see VerifyWindowResultSchema's own doc
  // comment for why a block-level average can't catch a bad entrance/exit
  // on its own): only ever runs for an event that actually authors
  // `motion` — a format with none gets an empty `windows` array, same as
  // today's exact behavior for every draft that predates this.
  const windowResults: VerifyWindowResult[] = [];
  for (const block of verifyFormat.blocks) {
    const span = splitBlocks.get(block.id);
    if (!span) continue;
    const videoSpans = edlFinal.video.filter((v) => v.blockId === block.id);
    if (videoSpans.length === 0) continue;
    const blockTlInSec = Math.min(...videoSpans.map((v) => v.tlInSec));

    for (const event of block.events) {
      if (event.kind !== "overlay" || !event.motion) continue;
      const overlay = edlFinal.overlays.find((o) => o.id === event.id);
      if (!overlay) continue; // dropped in pass 2 despite the placeholder — unexpected, nothing to measure

      const phases: Array<{ name: "enter" | "exit"; tlStartSec: number; durationSec: number }> = [];
      if (event.motion.enter) phases.push({ name: "enter", tlStartSec: overlay.tlInSec, durationSec: event.motion.enter.durationSec });
      if (event.motion.exit) {
        phases.push({ name: "exit", tlStartSec: overlay.tlOutSec - event.motion.exit.durationSec, durationSec: event.motion.exit.durationSec });
      }

      for (const phase of phases) {
        // The reference-side window at the SAME offset from this block's
        // own start, mapped through the split span exactly like the
        // block-level measurement above does — this is what lets the
        // rendered animation be compared against how the reference itself
        // actually looked at that same relative moment.
        const refAtSec = span.srcInSec + (phase.tlStartSec - blockTlInSec);
        const measurableSec = Math.min(phase.durationSec, span.srcOutSec - refAtSec);
        if (refAtSec < span.srcInSec - 0.01 || measurableSec <= 0.05) {
          windowResults.push({
            eventId: event.id,
            blockId: block.id,
            phase: phase.name,
            skipped: "animation window falls outside the reference's own matched span",
          });
          continue;
        }
        try {
          const ssim = measureSsim(
            outPath,
            phase.tlStartSec,
            sourcePath,
            refAtSec,
            measurableSec,
            verifyFormat.width,
            verifyFormat.height,
            verifyFormat.fps,
          );
          windowResults.push({ eventId: event.id, blockId: block.id, phase: phase.name, ssim });
        } catch (err) {
          windowResults.push({
            eventId: event.id,
            blockId: block.id,
            phase: phase.name,
            skipped: `ssim measurement failed: ${(err as Error).message}`,
          });
        }
      }
    }
  }

  return {
    draftId,
    createdAt: new Date().toISOString(),
    overallScore,
    blocks: blockResults,
    windows: windowResults,
    diagnostics: [...diagnostics, ...edlPass1.diagnostics, ...edlFinal.diagnostics],
  };
};

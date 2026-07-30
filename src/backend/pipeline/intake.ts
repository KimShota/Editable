import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { JobManifestSchema } from "./schemas";
import { BoundAsset, BoundFile, FilledFormat, Format, Slot } from "./types";
import { loadFormat } from "./loader";
import { matteFramesBatch } from "./generation/matte";
import { loadPlatesManifest } from "./generation/plates";
import { measureHeadBBox, measureSubjectBBox } from "./generation/subjectFit";

/**
 * Module 2 — Intake and slot binding.
 * Takes the chosen format plus the user's job manifest, binds each asset
 * to its named slot, and validates everything: every required slot filled,
 * every file present and of the right media type, every voice clip carrying
 * an audio track. Catches broken uploads before they become broken renders,
 * and reports ALL problems at once instead of one per run.
 */

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

type ProbedMedia = {
  mediaType: "video" | "image" | "audio";
  durationSec?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
};

/** Classify a media file and pull the metadata later stages rely on. */
export const probeFile = (absPath: string): ProbedMedia => {
  const raw = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", absPath],
    { encoding: "utf8" },
  );
  const probe = JSON.parse(raw) as {
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      disposition?: { attached_pic?: number };
    }>;
    format?: { duration?: string };
  };

  const streams = probe.streams ?? [];
  const durationSec = probe.format?.duration
    ? Number(probe.format.duration)
    : undefined;
  const video = streams.find(
    (s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1,
  );
  const hasAudio = streams.some((s) => s.codec_type === "audio");

  // Images decode as a single-frame "video" stream under ffprobe — read it
  // for width/height (assemble.ts needs the real aspect ratio to size an
  // overlay's default on-canvas box to actually fit the picture, not the
  // whole frame), but classify by extension rather than stream shape.
  if (IMAGE_EXTENSIONS.has(path.extname(absPath).toLowerCase())) {
    return { mediaType: "image", width: video?.width, height: video?.height };
  }

  if (video) {
    return {
      mediaType: "video",
      durationSec,
      width: video.width,
      height: video.height,
      hasAudio,
    };
  }
  if (hasAudio) {
    return { mediaType: "audio", durationSec };
  }
  throw new Error(`no decodable audio or video stream in ${absPath}`);
};

const FRAMING_SAMPLE_COUNT = 9;
/** Same tolerance shape as backgroundReplace.ts's own DESK_OVERLAP_MARGIN_FRAC
 *  (kept as a separate local constant rather than a shared import — this
 *  check and the composite-time solve are two different concerns that
 *  happen to use the same margin, not one relying on the other). */
const DESK_OVERLAP_MARGIN_FRAC = 0.02;
/** How far under the required ratio a take is still allowed to pass here
 *  — this is a cheap 9-frame Vision estimate, coarser than the matte
 *  stage's own per-block measurement (which runs on the actual chosen
 *  matting engine, sampling every frame of the block's real span), so a
 *  take right at the boundary shouldn't be rejected at upload only to
 *  turn out fine once actually composited. The matte/composite stages are
 *  still the final, authoritative check — this is a cheap early warning,
 *  not a replacement for them. */
const FRAMING_TOLERANCE_HEAD_HEIGHTS = 0.15;

/**
 * Cheap pre-check for the office talking-head desk-overlap requirement
 * (see backgroundReplace.ts's solveDeskOverlap doc comment for the full
 * story): samples ~9 frames of the speaking take, mattes them with Vision
 * (not RVM — 9 stills have no temporal dimension for RVM's recurrence to
 * help with, and Vision's fixed ~0.3-0.4s process-start cost is
 * negligible for a handful of frames), and estimates how many head-
 * heights of body show below the crown. Runs before any generate-stage
 * spend, so a take that can never reach the desk fails at upload with an
 * actionable message instead of after a full (possibly paid) render.
 *
 * The required ratio is DERIVED from the format's own manifest
 * (deskEdgeFrac, headTopFrac, headHeightFrac) — never a hardcoded
 * constant — so this generalizes to any office-composite format's own
 * framing target, not just this one template's numbers.
 */
const checkTalkingHeadFraming = (format: Format, take: BoundFile, errors: string[]): void => {
  if (!format.blocks.some((b) => b.backgroundReplace)) return;
  if (take.durationSec === undefined || take.durationSec <= 0) return;

  let manifest;
  try {
    manifest = loadPlatesManifest(format.id);
  } catch {
    // A format that flags backgroundReplace but ships no plates is a
    // packaging bug (see loadPlatesManifest's own doc comment) — it'll
    // surface loudly at the composite stage; intake shouldn't crash on it.
    return;
  }
  const target = manifest.reference.talkingHead;
  const requiredHeadHeights = (manifest.deskEdgeFrac + DESK_OVERLAP_MARGIN_FRAC - target.headTopFrac) / target.headHeightFrac;

  const sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-framing-check-"));
  try {
    const framesDir = path.join(sampleDir, "frames");
    fs.mkdirSync(framesDir, { recursive: true });
    const sampleFps = FRAMING_SAMPLE_COUNT / take.durationSec;
    execFileSync("ffmpeg", [
      "-y", "-v", "error",
      "-i", take.absPath,
      "-vf", `fps=${sampleFps},scale=${format.width}:${format.height}:force_original_aspect_ratio=increase,crop=${format.width}:${format.height}`,
      path.join(framesDir, "f%05d.png"),
    ]);
    const masksDir = path.join(sampleDir, "masks");
    matteFramesBatch(framesDir, masksDir);

    const headBBox = measureHeadBBox(masksDir, format.width, format.height, FRAMING_SAMPLE_COUNT);
    const subjectBBox = measureSubjectBBox(masksDir, format.width, format.height, FRAMING_SAMPLE_COUNT);
    if (!headBBox || !subjectBBox) return; // inconclusive read — don't block on it, the matte stage will catch a real problem

    const measuredHeadHeights = (subjectBBox.bottomFrac - headBBox.topFrac) / Math.max(0.001, headBBox.bottomFrac - headBBox.topFrac);
    if (measuredHeadHeights < requiredHeadHeights - FRAMING_TOLERANCE_HEAD_HEIGHTS) {
      errors.push(
        `speaking take framing: shows only ~${measuredHeadHeights.toFixed(1)} head-heights of body below the top of your head, ` +
          `but this template needs ~${requiredHeadHeights.toFixed(1)} so the desk can occlude you correctly (not end in mid-air above it). ` +
          `Re-film showing yourself from the top of your head down to at least your elbows/mid-torso — a dark, solid surface overhead, ` +
          `even front-facing light, and no strong light behind you.`,
      );
    }
  } finally {
    fs.rmSync(sampleDir, { recursive: true, force: true });
  }
};

/** Every slot the format declares: block, shared, music, identity, speaking
 *  take, and final clip slots. */
export const allSlots = (format: Format): Slot[] => [
  ...format.blocks.flatMap((b) => b.slots),
  ...format.sharedSlots,
  ...(format.musicSlot ? [format.musicSlot] : []),
  ...(format.identitySlot ? [format.identitySlot] : []),
  ...(format.speakingTakeSlot ? [format.speakingTakeSlot] : []),
  ...(format.finalClipSlot ? [format.finalClipSlot] : []),
];

export const intake = (jobDir: string): FilledFormat => {
  const absJobDir = path.resolve(jobDir);
  const manifestPath = path.join(absJobDir, "job.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No job manifest at ${manifestPath}`);
  }

  const manifestParsed = JobManifestSchema.safeParse(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")),
  );
  if (!manifestParsed.success) {
    throw new Error(
      `job.json failed validation:\n${z.prettifyError(manifestParsed.error)}`,
    );
  }
  const manifest = manifestParsed.data;
  const format = loadFormat(manifest.format);

  const errors: string[] = [];
  const bindings: Record<string, BoundAsset> = {};
  const slots = allSlots(format);
  const slotNames = new Set(slots.map((s) => s.name));
  // Multiple files are only meaningful for a voice block's main clip (takes
  // to auto-order/concatenate by transcript) or the identity slot (several
  // reference photos of the same person). Screen recordings, memes, music
  // etc. always bind exactly one file.
  const multiFileSlots = new Set([
    ...format.blocks.filter((b) => b.kind === "voice").map((b) => b.videoSlot),
    ...(format.identitySlot ? [format.identitySlot.name] : []),
  ]);

  for (const name of Object.keys(manifest.bindings)) {
    if (!slotNames.has(name)) {
      console.warn(`intake: ignoring binding "${name}" — format declares no such slot`);
    }
  }

  /** Probes one job-dir-relative file path into a BoundFile, or pushes an error and returns null. */
  const bindOneFile = (slotName: string, relPath: string): BoundFile | null => {
    const absPath = path.resolve(absJobDir, relPath);
    if (!fs.existsSync(absPath)) {
      errors.push(`slot "${slotName}": file not found: ${relPath}`);
      return null;
    }
    try {
      const probed = probeFile(absPath);
      return { path: relPath, absPath, ...probed };
    } catch (err) {
      errors.push(`slot "${slotName}": ${(err as Error).message}`);
      return null;
    }
  };

  // In single-take mode, a voice block's own clip slot is DERIVED from
  // speakingTakeSlot (see the derivation below) rather than filled
  // directly — same "not a manifest error to be absent" treatment as a
  // generated slot, just for a different reason. `optional` blocks are
  // excluded: they're filmed as their own standalone clip (see
  // BlockSchema's doc comment), so their slot is filled the ordinary way
  // (or left unbound) rather than overwritten with the shared take.
  const derivedFromTake = new Set(
    format.speakingTakeSlot
      ? format.blocks.filter((b) => b.kind === "voice" && !b.optional).map((b) => b.videoSlot)
      : [],
  );

  for (const slot of slots) {
    const fill = manifest.bindings[slot.name];
    if (!fill) {
      // A generated slot is filled by the `generate` stage, not the
      // manifest — its absence here is normal, not an error. If the user
      // supplies a binding anyway (the "files"/"file" branches below), it's
      // honored as-is and generation is skipped for that slot.
      if (slot.required && !slot.generation && !derivedFromTake.has(slot.name)) {
        errors.push(`required slot "${slot.name}" (${slot.mediaType}) is not filled`);
      }
      continue;
    }

    if ("text" in fill) {
      if (slot.mediaType !== "text") {
        errors.push(`slot "${slot.name}" expects a ${slot.mediaType} file but got text`);
        continue;
      }
      bindings[slot.name] = { type: "text", text: fill.text };
      continue;
    }

    if (slot.mediaType === "text") {
      errors.push(`slot "${slot.name}" expects text but got a file`);
      continue;
    }

    if ("files" in fill) {
      if (!multiFileSlots.has(slot.name)) {
        errors.push(
          `slot "${slot.name}": multiple files are only supported for a voice block's main clip or the identity slot`,
        );
        continue;
      }
      const files = fill.files
        .map((f) => bindOneFile(slot.name, f))
        .filter((f): f is BoundFile => f !== null);
      if (files.length !== fill.files.length) continue; // a per-file error was already pushed
      const mismatch = files.find((f) => f.mediaType !== slot.mediaType);
      if (mismatch) {
        errors.push(
          `slot "${slot.name}" expects ${slot.mediaType} but ${mismatch.path} is ${mismatch.mediaType}`,
        );
        continue;
      }
      bindings[slot.name] = { type: "files", files };
      continue;
    }

    const bound = bindOneFile(slot.name, fill.file);
    if (!bound) continue;
    if (bound.mediaType !== slot.mediaType) {
      errors.push(
        `slot "${slot.name}" expects ${slot.mediaType} but ${fill.file} is ${bound.mediaType}`,
      );
      continue;
    }
    bindings[slot.name] = { type: "file", ...bound };
  }

  // Single-take mode: every voice block's own clip binding is the SAME
  // shared take file (splitTake.ts later locates that block's own span
  // inside it). Cloning the binding here — rather than teaching every
  // downstream stage about speakingTakeSlot — is what keeps
  // transcribe/trim/resolveRoles/assemble completely unchanged; they just
  // see an ordinary bound clip per block, same as any other format.
  if (format.speakingTakeSlot) {
    const take = bindings[format.speakingTakeSlot.name];
    if (take?.type === "file") {
      for (const slotName of derivedFromTake) {
        bindings[slotName] = take;
      }
    }
    // If the take itself failed to bind, an error for its own slot was
    // already pushed above — no need to duplicate it per derived block.
  }

  // Voice blocks are transcribed — their clip(s) must actually carry audio.
  for (const block of format.blocks) {
    const clip = bindings[block.videoSlot];
    if (block.kind !== "voice") continue;
    const files = clip?.type === "file" ? [clip] : clip?.type === "files" ? clip.files : [];
    if (files.some((f) => f.hasAudio === false)) {
      errors.push(
        `block "${block.id}" is a voice block but its clip "${block.videoSlot}" has no audio track`,
      );
    }
  }

  // Office-composite formats (see checkTalkingHeadFraming's own doc
  // comment): catch a take that can never reach the desk before any
  // generate-stage spend, not after a full render.
  if (format.speakingTakeSlot) {
    const take = bindings[format.speakingTakeSlot.name];
    if (take?.type === "file") {
      checkTalkingHeadFraming(format, take, errors);
    }
  }

  if (errors.length > 0) {
    throw new Error(`intake failed:\n  - ${errors.join("\n  - ")}`);
  }

  return {
    jobId: path.basename(absJobDir),
    jobDir: absJobDir,
    formatId: format.id,
    bindings,
    overrides: manifest.overrides,
    lexicon: manifest.lexicon,
  };
};

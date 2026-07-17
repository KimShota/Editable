import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { JobManifestSchema } from "./schemas";
import { BoundAsset, FilledFormat, Format, Slot } from "./types";
import { loadFormat } from "./loader";

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
  if (IMAGE_EXTENSIONS.has(path.extname(absPath).toLowerCase())) {
    return { mediaType: "image" };
  }

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

/** Every slot the format declares, block slots plus the optional music slot. */
export const allSlots = (format: Format): Slot[] => [
  ...format.blocks.flatMap((b) => b.slots),
  ...(format.musicSlot ? [format.musicSlot] : []),
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

  for (const name of Object.keys(manifest.bindings)) {
    if (!slotNames.has(name)) {
      console.warn(`intake: ignoring binding "${name}" — format declares no such slot`);
    }
  }

  for (const slot of slots) {
    const fill = manifest.bindings[slot.name];
    if (!fill) {
      if (slot.required) {
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
      errors.push(`slot "${slot.name}" expects text but got a file (${fill.file})`);
      continue;
    }
    const absPath = path.resolve(absJobDir, fill.file);
    if (!fs.existsSync(absPath)) {
      errors.push(`slot "${slot.name}": file not found: ${fill.file}`);
      continue;
    }
    let probed: ProbedMedia;
    try {
      probed = probeFile(absPath);
    } catch (err) {
      errors.push(`slot "${slot.name}": ${(err as Error).message}`);
      continue;
    }
    if (probed.mediaType !== slot.mediaType) {
      errors.push(
        `slot "${slot.name}" expects ${slot.mediaType} but ${fill.file} is ${probed.mediaType}`,
      );
      continue;
    }
    bindings[slot.name] = { type: "file", path: fill.file, absPath, ...probed };
  }

  // Voice blocks are transcribed — their clips must actually carry audio.
  for (const block of format.blocks) {
    const clip = bindings[block.videoSlot];
    if (block.kind === "voice" && clip?.type === "file" && clip.hasAudio === false) {
      errors.push(
        `block "${block.id}" is a voice block but its clip "${block.videoSlot}" has no audio track`,
      );
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
  };
};

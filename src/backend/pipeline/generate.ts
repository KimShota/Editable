import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { probeFile } from "./intake";
import { GeneratorChoice, pickGenerationProvider } from "./generation";
import { loadStyleProfile } from "./generation/styleProfile";
import { FilledFormatSchema, InsertsSchema } from "./schemas";
import { BoundAsset, FilledFormat, Format, GeneratedInsert, Inserts, StyleProfile } from "./types";

/**
 * Module 2.5 — Generate.
 * Fills every slot the format marks with a `generation` spec (an insert:
 * a cutaway or montage clip, never a voice block's own spoken clip — see
 * GenerationSpecSchema) with a synthesized MP4, then binds it into
 * `filled.bindings` exactly as if the user had supplied that file. Nothing
 * downstream (transcribe/trim/roles/assemble/render) needs to know a slot
 * was generated rather than filmed — it just sees an ordinary bound clip.
 *
 * Must run BEFORE trim: a broll block's trim point (trim.ts) requires its
 * clip to already be bound with a known duration, and montage/end-card
 * inserts are broll blocks. Runs right after intake, before transcribe,
 * since generated slots are never voice-block clips and have nothing to
 * transcribe.
 *
 * Generation is cached by a hash of every input that could change the
 * output (identity photos, StyleProfile, shot description, seed, target
 * dimensions, provider) — a re-run with nothing changed reuses the prior
 * file instead of calling the provider again, keeping the job reproducible
 * and cheap to re-render (mirrors how the rest of the pipeline treats a
 * job as deterministic given the same inputs).
 */

const identityImagePaths = (format: Format, filled: FilledFormat): string[] => {
  if (!format.identitySlot) return [];
  const asset: BoundAsset | undefined = filled.bindings[format.identitySlot.name];
  if (asset?.type === "files") return asset.files.map((f) => f.absPath);
  if (asset?.type === "file") return [asset.absPath];
  return [];
};

const requestHash = (parts: {
  identityImages: string[];
  styleProfile: StyleProfile;
  shot: string;
  durationSec: number;
  seed: number;
  width: number;
  height: number;
  fps: number;
  provider: string;
}): string =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify({ ...parts, identityImages: [...parts.identityImages].sort() }))
    .digest("hex")
    .slice(0, 16);

export const generate = async (
  format: Format,
  filled: FilledFormat,
  generatorChoice: GeneratorChoice = "auto",
): Promise<{ filled: FilledFormat; inserts: Inserts }> => {
  const generatedSlots = format.blocks.flatMap((block) =>
    block.slots.filter((s) => s.generation).map((slot) => ({ block, slot })),
  );
  if (generatedSlots.length === 0) {
    return { filled, inserts: InsertsSchema.parse({ inserts: [], skipped: [] }) };
  }

  const provider = pickGenerationProvider(generatorChoice);
  const styleProfile = loadStyleProfile(format.id);
  const identityImages = identityImagePaths(format, filled);

  const generatedDir = path.join(filled.jobDir, "generated");
  fs.mkdirSync(generatedDir, { recursive: true });

  const newBindings: Record<string, BoundAsset> = {};
  const inserts: GeneratedInsert[] = [];
  const skipped: Inserts["skipped"] = [];

  for (const { block, slot } of generatedSlots) {
    const spec = slot.generation!;

    // A generation-marked slot the user filled anyway is an opt-out —
    // their footage is used as-is, no generation happens for it.
    if (filled.bindings[slot.name]) {
      skipped.push({ slotName: slot.name, blockId: block.id });
      continue;
    }

    if (identityImages.length === 0) {
      throw new Error(
        `generate: block "${block.id}" slot "${slot.name}" needs generation but no identity photos ` +
          `are bound (format.identitySlot "${format.identitySlot?.name}")`,
      );
    }

    const relPath = path.join("generated", `${slot.name}.mp4`);
    const absOutPath = path.join(filled.jobDir, relPath);
    const hashFile = `${absOutPath}.hash`;

    const hash = requestHash({
      identityImages,
      styleProfile,
      shot: spec.shot,
      durationSec: spec.durationSec,
      seed: spec.seed,
      width: format.width,
      height: format.height,
      fps: format.fps,
      provider: provider.name,
    });
    const cachedHash = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, "utf8") : undefined;
    const cacheHit = cachedHash === hash && fs.existsSync(absOutPath);

    if (!cacheHit) {
      await provider.generate({
        identityImages,
        styleProfile,
        kind: spec.kind,
        shot: spec.shot,
        durationSec: spec.durationSec,
        seed: spec.seed,
        width: format.width,
        height: format.height,
        fps: format.fps,
        outPath: absOutPath,
      });
      fs.writeFileSync(hashFile, hash);
    }

    const probed = probeFile(absOutPath);
    newBindings[slot.name] = {
      type: "file",
      path: relPath,
      absPath: absOutPath,
      mediaType: "video",
      durationSec: probed.durationSec,
      width: probed.width,
      height: probed.height,
      hasAudio: probed.hasAudio,
    };
    inserts.push({
      slotName: slot.name,
      blockId: block.id,
      kind: spec.kind,
      shot: spec.shot,
      durationSec: spec.durationSec,
      seed: spec.seed,
      provider: provider.name,
      cacheHit,
      path: relPath,
      width: probed.width,
      height: probed.height,
      hasAudio: probed.hasAudio,
    });
  }

  const updatedFilled = FilledFormatSchema.parse({
    ...filled,
    bindings: { ...filled.bindings, ...newBindings },
  });

  return { filled: updatedFilled, inserts: InsertsSchema.parse({ inserts, skipped }) };
};

/** Re-exported for callers that want to validate a persisted inserts.json. */
export const parseInserts = (raw: unknown): Inserts => {
  const parsed = InsertsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`inserts.json failed validation:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
};

/**
 * Rebinds a pure-intake FilledFormat with bindings recorded in a previously
 * written inserts.json, without re-probing or re-running generation. For
 * when `generate` didn't run in THIS invocation (e.g. `--only transcribe`)
 * but did in an earlier one — filled.json on disk is always pure intake
 * output (see this module's doc comment), so those stages would otherwise
 * see the generated slots as unbound.
 */
export const applyInserts = (filled: FilledFormat, inserts: Inserts): FilledFormat => {
  if (inserts.inserts.length === 0) return filled;
  const bindings = { ...filled.bindings };
  for (const insert of inserts.inserts) {
    bindings[insert.slotName] = {
      type: "file",
      path: insert.path,
      absPath: path.join(filled.jobDir, insert.path),
      mediaType: "video",
      durationSec: insert.durationSec,
      width: insert.width,
      height: insert.height,
      hasAudio: insert.hasAudio,
    };
  }
  return FilledFormatSchema.parse({ ...filled, bindings });
};

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PlatesManifestSchema } from "../schemas";
import { PlatesManifest } from "../types";
import { formatAssetsDir } from "../paths";

/**
 * Loads a format's checked-in template plates manifest (see
 * schemas.ts's PlatesManifestSchema doc comment) — built once by
 * authoring/buildTemplateAssets.ts and committed to
 * formats/assets/<formatId>/assets.json. Unlike loadStyleProfile, there is
 * no bland-default fallback: a format that flags backgroundReplace/
 * plateComposite blocks but ships no plates is a packaging bug, not a
 * per-job condition to degrade gracefully around.
 */
export const loadPlatesManifest = (formatId: string): PlatesManifest => {
  const file = path.join(formatAssetsDir(formatId), "assets.json");
  if (!fs.existsSync(file)) {
    throw new Error(`loadPlatesManifest: no plates manifest at ${file} — run buildTemplateAssets for "${formatId}"`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const parsed = PlatesManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`plates manifest for "${formatId}" failed validation:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
};

/** Absolute path to one of a format's checked-in plate images. */
export const platePath = (formatId: string, manifest: PlatesManifest, plateName: string): string => {
  const plate = manifest.plates[plateName];
  if (!plate) {
    throw new Error(
      `platePath: no plate "${plateName}" in "${formatId}"'s manifest (have: ${Object.keys(manifest.plates).join(", ")})`,
    );
  }
  return path.join(formatAssetsDir(formatId), plate.file);
};

/** Absolute path to the format's desk-foreground RGBA overlay. */
export const deskForegroundPath = (formatId: string, manifest: PlatesManifest): string =>
  path.join(formatAssetsDir(formatId), manifest.deskForeground);

/** Absolute path to the format's checked-in music bed, if it has one. */
export const musicBedPath = (formatId: string, manifest: PlatesManifest): string | undefined =>
  manifest.musicBed ? path.join(formatAssetsDir(formatId), manifest.musicBed.file) : undefined;

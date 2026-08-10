import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { FormatSchema } from "./schemas";
import { Format } from "./types";
import { formatsDir } from "./paths";

/**
 * Module 1 — Format loader.
 * Takes a format id, returns a validated format definition. This is where
 * the founder's authored judgment enters the system; everything downstream
 * trusts the shape because it is validated here, once.
 */

/** Reserved slot name for an auto-synthesized speaking-take upload — see
 *  withImplicitSpeakingTake's own doc comment. Synthesis is skipped (not an
 *  error) on the rare collision with an author-chosen slot name, same
 *  "never block a build" spirit as every other soft-fallback in this
 *  pipeline. */
const IMPLICIT_SPEAKING_TAKE_SLOT_NAME = "speakingTake";

type RawSlotRef = { name?: unknown } | undefined;
type RawFormat = {
  speakingTakeSlot?: unknown;
  blocks?: Array<{ kind?: unknown; slots?: Array<{ name?: unknown }> }>;
  sharedSlots?: Array<{ name?: unknown }>;
  musicSlot?: RawSlotRef;
  identitySlot?: RawSlotRef;
  finalClipSlot?: RawSlotRef;
};

/**
 * Every format with 2+ voice blocks and no author-declared speakingTakeSlot
 * gets one synthesized here, before validation — "one continuous take of
 * all your lines" (see splitTake.ts) becomes an option on EVERY multi-line
 * format, not just ones that opted in at authoring time, without making
 * every format author hand-declare it. A format with a single voice block
 * is left alone — "one clip vs. several" is moot when there's only one line.
 *
 * Unlike an authored speakingTakeSlot (e.g. cinematic-debut-manifesto's,
 * `required: true` — the ONLY way to supply voice footage there), the
 * synthesized one is always `required: false`: a format keeps its existing
 * per-block-upload behavior by default, and a job only enters single-take
 * (or mixed) mode by actually binding it — see intake.ts's derivedFromTake
 * and splitTake.ts's isTakeCovered, both keyed off the BINDING, not the
 * format, so per-block clips and one whole take can be mixed freely too.
 */
const withImplicitSpeakingTake = (raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null) return raw;
  const format = raw as RawFormat;
  if (format.speakingTakeSlot) return raw;

  const blocks = Array.isArray(format.blocks) ? format.blocks : [];
  const voiceBlockCount = blocks.filter((b) => b?.kind === "voice").length;
  if (voiceBlockCount < 2) return raw;

  const existingNames = new Set<string>();
  for (const block of blocks) {
    for (const slot of Array.isArray(block?.slots) ? block.slots : []) {
      if (typeof slot?.name === "string") existingNames.add(slot.name);
    }
  }
  for (const slot of [
    ...(Array.isArray(format.sharedSlots) ? format.sharedSlots : []),
    format.musicSlot,
    format.identitySlot,
    format.finalClipSlot,
  ]) {
    if (typeof slot?.name === "string") existingNames.add(slot.name);
  }
  if (existingNames.has(IMPLICIT_SPEAKING_TAKE_SLOT_NAME)) return raw;

  return {
    ...format,
    speakingTakeSlot: {
      name: IMPLICIT_SPEAKING_TAKE_SLOT_NAME,
      mediaType: "video",
      required: false,
      label: "All your lines, one clip",
      instructions:
        "Film everything in one go with a short pause between lines — we'll find where each one starts automatically. Filming separately instead? Skip this and use each block's own clip below.",
    },
  };
};

export const loadFormat = (formatId: string): Format => {
  const file = path.join(formatsDir, `${formatId}.json`);
  if (!fs.existsSync(file)) {
    const available = listFormats().join(", ") || "(none)";
    throw new Error(
      `Unknown format "${formatId}" — no such file ${file}. Available formats: ${available}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Format file ${file} is not valid JSON: ${(err as Error).message}`);
  }

  const parsed = FormatSchema.safeParse(withImplicitSpeakingTake(raw));
  if (!parsed.success) {
    throw new Error(
      `Format "${formatId}" failed validation:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
};

/** All format ids available in the library (one config file per format). */
export const listFormats = (): string[] => {
  if (!fs.existsSync(formatsDir)) return [];
  return fs
    .readdirSync(formatsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
};

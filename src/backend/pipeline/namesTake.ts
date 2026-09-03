import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeFile } from "./intake";
import { detectSilenceIntervals, speechRegions } from "./trim";
import { extractAudioOnly } from "./videoEffects";
import { PIPELINE_VERSION } from "./pipelineVersion";
import { requireWhisperModel, transcribeFile } from "./whisper";
import { FilledFormat, Format } from "./types";

/**
 * Module: names-take split. See FormatSchema's `namesTakeSlot` doc comment
 * for the feature this exists for — a separate take where the creator says
 * each voice block's own "name" back to back, nothing else, and Editable
 * pulls out just each one's audio to dub over that block's own front
 * silence (assemble.ts's `leadInSec`), timed off the new "nameAudioStart"
 * anchor instead of a spoken-phrase anchor.
 *
 * Splitting here is deliberately NOT anchor/phrase matching (unlike
 * splitTake.ts, which walks a shared take via each block's own literal
 * anchor) — there's no fixed vocabulary to match against, since the names
 * are the creator's own content, not something a format author can know in
 * advance. Instead this reuses the SAME silence-detection primitives
 * dead-air trimming already uses (trim.ts's detectSilenceIntervals /
 * speechRegions): the names take is just N spoken words separated by
 * pauses, so its speech regions ARE the per-name spans, one per region, in
 * the order they were said.
 *
 * A block that also declares `nameTextSlot` (BlockSchema's own doc
 * comment) gets that region's audio TRANSCRIBED too (whisper.cpp, same
 * engine transcribe.ts uses for the main takes) and registered as a
 * synthetic TEXT binding for that slot — so a display name (e.g. a tier
 * board's own icon label) is available with nothing typed, while still
 * being an ordinary editable text slot the user can correct if a brand
 * name gets mangled. Only runs when the slot isn't ALREADY bound (a
 * user-typed value always wins, never overwritten), and only reads
 * `nameTextSlot`'s CURRENT binding off `filled` — the same "transform,
 * then only the transformed version is persisted" contract every other
 * synthetic binding here follows.
 */

const requestHash = (parts: Record<string, unknown>): string =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify({ ...parts, pipelineVersion: PIPELINE_VERSION }))
    .digest("hex")
    .slice(0, 16);

/** Same cache-by-hash-sidecar shape backgroundReplace.ts/generate.ts each
 *  keep their own copy of — skips re-running ffmpeg when the source file
 *  and region bounds haven't changed since the last build. */
const withCache = (outPath: string, hash: string, build: () => void): void => {
  const hashFile = `${outPath}.hash`;
  const cached = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, "utf8") : undefined;
  if (cached === hash && fs.existsSync(outPath)) return;
  build();
  fs.writeFileSync(hashFile, hash);
};

export type NameAudioClip = {
  blockId: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  path: string;
};

export type NamesTakeResult = {
  filled: FilledFormat;
  clips: NameAudioClip[];
};

/** Whether `slotName` already carries a real (non-empty) user-typed value
 *  — the ONLY condition that skips transcription for a `nameTextSlot`, so
 *  a manual override always wins over auto-fill, on every build. */
const hasTypedText = (filled: FilledFormat, slotName: string): boolean => {
  const bound = filled.bindings[slotName];
  return bound?.type === "text" && bound.text.trim().length > 0;
};

/**
 * No-op (returns `filled` unchanged, `clips: []`) when the format declares
 * no `namesTakeSlot`, or the job never bound it — safe to call
 * unconditionally for every build. Otherwise: detects one speech region
 * per voice block (throws if the count doesn't match — see below),
 * extracts each region's AUDIO ONLY into its own file, and registers it as
 * a synthetic "<videoSlot>-nameAudio" binding, mirroring exactly how
 * backgroundReplace.ts registers its own "<videoSlot>-ecu" synthetic
 * binding for ecuCutaway. A block that also declares `nameTextSlot` (and
 * hasn't already been typed into by the user — see `hasTypedText`) gets
 * that same region transcribed and written into `nameTextSlot` too — see
 * this module's own doc comment above.
 *
 * Regions map to voice blocks POSITIONALLY, in format.blocks order — the
 * creator is instructed (see the slot's own `instructions`) to say names
 * in the same order as their item uploads. A wrong ORDER isn't detected
 * here (that would need matching against block content this module has no
 * access to); a wrong COUNT is, and fails loudly rather than guessing.
 */
export const extractNameAudioClips = (format: Format, filled: FilledFormat): NamesTakeResult => {
  if (!format.namesTakeSlot) return { filled, clips: [] };
  const bound = filled.bindings[format.namesTakeSlot.name];
  if (bound?.type !== "file") return { filled, clips: [] };

  const durationSec = bound.durationSec ?? 0;
  const silences = detectSilenceIntervals(bound.absPath, durationSec);
  const regions = speechRegions(silences, durationSec);
  const voiceBlocks = format.blocks.filter((b) => b.kind === "voice" && !b.optional);

  if (regions.length !== voiceBlocks.length) {
    throw new Error(
      `namesTake: found ${regions.length} spoken name${regions.length === 1 ? "" : "s"} in ` +
        `"${format.namesTakeSlot.label ?? format.namesTakeSlot.name}" but this format expects ` +
        `${voiceBlocks.length} — check for names said too close together (no pause between them) ` +
        `or extra pauses mid-take, then re-upload.`,
    );
  }

  const generatedDir = path.join(filled.jobDir, "generated");
  fs.mkdirSync(generatedDir, { recursive: true });

  const newBindings: FilledFormat["bindings"] = {};
  const clips: NameAudioClip[] = [];

  // whisper is only ever invoked when some block both wants it AND hasn't
  // already been typed into — the overwhelmingly common no-op case (no
  // format declares nameTextSlot, or the user typed every name already)
  // never pays for the model check or a temp dir.
  const needsTranscription = voiceBlocks.some(
    (b) => b.nameTextSlot && !hasTypedText(filled, b.nameTextSlot),
  );
  let whisperWorkDir: string | undefined;
  if (needsTranscription) {
    requireWhisperModel();
    whisperWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-namestake-whisper-"));
  }

  try {
    voiceBlocks.forEach((block, i) => {
      const region = regions[i];
      const slotName = `${block.videoSlot}-nameAudio`;
      const relPath = path.join("generated", `${slotName}.m4a`);
      const absOutPath = path.join(filled.jobDir, relPath);
      const hash = requestHash({ srcAbsPath: bound.absPath, startSec: region.startSec, endSec: region.endSec });

      withCache(absOutPath, hash, () => {
        extractAudioOnly(bound.absPath, absOutPath, {
          atSec: region.startSec,
          durationSec: region.endSec - region.startSec,
        });
      });

      const probed = probeFile(absOutPath);
      newBindings[slotName] = {
        type: "file",
        path: relPath,
        absPath: absOutPath,
        mediaType: "audio",
        durationSec: probed.durationSec,
      };
      clips.push({
        blockId: block.id,
        startSec: region.startSec,
        endSec: region.endSec,
        durationSec: probed.durationSec ?? region.endSec - region.startSec,
        path: relPath,
      });

      if (block.nameTextSlot && whisperWorkDir && !hasTypedText(filled, block.nameTextSlot)) {
        // Transcribed straight off the already-isolated name-audio clip
        // (not the whole names-take file) — one short phrase, no other
        // voice to confuse it with. A silent/unintelligible region (rare;
        // the region itself came from real detected speech) still yields
        // SOME binding — empty string, not "leave unbound" — so a nested
        // `nameTextSlot` reference on the board's own entries/reveal
        // params (assemble.ts's resolveNestedSlots) renders the item
        // icon-only instead of dropping the whole item off the board.
        const words = transcribeFile(absOutPath, whisperWorkDir, filled.language);
        // whisper.cpp appends terminal punctuation per segment (a single
        // spoken name reads as "Gemini." not "Gemini") — stripped since
        // this is a display label, not a transcript.
        const text = words
          .map((w) => w.text)
          .join(" ")
          .trim()
          .replace(/[.,!?;:]+$/, "")
          .trim();
        newBindings[block.nameTextSlot] = { type: "text", text };
      }
    });
  } finally {
    if (whisperWorkDir) fs.rmSync(whisperWorkDir, { recursive: true, force: true });
  }

  return {
    filled: { ...filled, bindings: { ...filled.bindings, ...newBindings } },
    clips,
  };
};

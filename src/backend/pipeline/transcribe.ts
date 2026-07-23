import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { orderTakes } from "./literal";
import { FilledFormat, Format, Transcript } from "./types";
import { requireWhisperModel, transcribeFile } from "./whisper";

/**
 * Module 3 — Transcription.
 * For each voice block, runs whisper.cpp to produce word-level timestamps.
 * Silent b-roll blocks are skipped. Word times are seconds relative to the
 * RAW clip (trimming happens downstream, against these times).
 *
 * A voice block's main clip may be filmed as several separate takes (e.g.
 * the marker line "First is …" and the explanation shot separately) instead
 * of one continuous recording — see intake.ts. This is the earliest stage
 * with each take's own words, so it's also where playback order is decided
 * (orderTakes, in literal.ts): everything downstream (trim, roles, assemble)
 * just walks `takes` in that order and never needs to know it was more than
 * one file.
 */

export const transcribe = (format: Format, filled: FilledFormat): Transcript => {
  requireWhisperModel();

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-whisper-"));
  try {
    const blocks = [];
    for (const block of format.blocks) {
      if (block.kind !== "voice") continue;
      const clip = filled.bindings[block.videoSlot];

      if (clip?.type === "file") {
        const words = transcribeFile(clip.absPath, workDir);
        if (words.length === 0) {
          console.warn(
            `transcribe: no speech detected in voice block "${block.id}" (${clip.path})`,
          );
        }
        blocks.push({ blockId: block.id, takeOrder: [0], takes: [words] });
        continue;
      }

      if (clip?.type === "files") {
        const rawTakes = clip.files.map((f) => transcribeFile(f.absPath, workDir));
        const takeOrder = orderTakes(block, rawTakes);
        const takes = takeOrder.map((idx) => rawTakes[idx]);
        if (takes.every((w) => w.length === 0)) {
          console.warn(`transcribe: no speech detected in any take of voice block "${block.id}"`);
        }
        blocks.push({ blockId: block.id, takeOrder, takes });
        continue;
      }

      throw new Error(`transcribe: block "${block.id}" has no bound clip`);
    }
    return { blocks };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

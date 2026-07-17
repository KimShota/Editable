import { spawnSync } from "node:child_process";
import { BlockTrim, FilledFormat, Format, Transcript, TrimPoints } from "./types";

/**
 * Module 4 — Trim.
 * For each voice block, finds the first and last spoken moment and cuts the
 * dead air at head and tail. Two signals are combined, because whisper.cpp
 * tends to stretch the first word back over leading silence:
 *   - word timestamps from the transcript
 *   - ffmpeg silencedetect (leading silence end / trailing silence start)
 * The tighter bound wins on each side. Silent b-roll blocks pass through
 * roughly as filmed (v1 decision), capped at the format's brollDurationSec.
 *
 * Everything downstream times against the trimmed clip (trim-then-time).
 */

/** Breathing room kept around the speech, seconds. */
const PAD_SEC = 0.15;
const SILENCE_ARGS = "silencedetect=noise=-35dB:d=0.25";
/** Tolerance when deciding a silence touches the start/end of the clip. */
const EDGE_EPS = 0.06;

type SilenceBounds = {
  /** End of a silence that starts at the head of the clip, else 0. */
  leadingSilenceEndSec: number;
  /** Start of a silence that runs to the tail of the clip, else duration. */
  trailingSilenceStartSec: number;
};

export const detectSilenceBounds = (
  clipAbsPath: string,
  durationSec: number,
): SilenceBounds => {
  // silencedetect reports on stderr.
  const out = spawnSync(
    "ffmpeg",
    ["-i", clipAbsPath, "-af", SILENCE_ARGS, "-f", "null", "-"],
    { encoding: "utf8" },
  ).stderr;

  const events: Array<{ kind: "start" | "end"; atSec: number }> = [];
  for (const line of out.split("\n")) {
    const start = line.match(/silence_start:\s*([\d.]+)/);
    if (start) events.push({ kind: "start", atSec: Number(start[1]) });
    const end = line.match(/silence_end:\s*([\d.]+)/);
    if (end) events.push({ kind: "end", atSec: Number(end[1]) });
  }

  let leadingSilenceEndSec = 0;
  if (events[0]?.kind === "start" && events[0].atSec <= EDGE_EPS) {
    leadingSilenceEndSec = events[1]?.kind === "end" ? events[1].atSec : durationSec;
  }

  let trailingSilenceStartSec = durationSec;
  const last = events[events.length - 1];
  const secondLast = events[events.length - 2];
  if (last?.kind === "start") {
    // Silence still open at EOF.
    trailingSilenceStartSec = last.atSec;
  } else if (
    last?.kind === "end" &&
    last.atSec >= durationSec - EDGE_EPS &&
    secondLast?.kind === "start"
  ) {
    trailingSilenceStartSec = secondLast.atSec;
  }

  return { leadingSilenceEndSec, trailingSilenceStartSec };
};

export const trim = (
  format: Format,
  filled: FilledFormat,
  transcript: Transcript,
): TrimPoints => {
  const blocks: BlockTrim[] = [];

  for (const block of format.blocks) {
    const clip = filled.bindings[block.videoSlot];
    if (clip?.type !== "file" || clip.durationSec === undefined) {
      throw new Error(`trim: block "${block.id}" has no bound clip with a duration`);
    }
    const clipDuration = clip.durationSec;

    if (block.kind === "broll") {
      const target = block.brollDurationSec ?? clipDuration;
      blocks.push({
        blockId: block.id,
        srcInSec: 0,
        srcOutSec: Math.min(clipDuration, target),
      });
      continue;
    }

    const words = transcript.blocks.find((b) => b.blockId === block.id)?.words ?? [];
    if (words.length === 0) {
      // Graceful degradation: no detected speech → pass through as filmed.
      blocks.push({ blockId: block.id, srcInSec: 0, srcOutSec: clipDuration });
      continue;
    }

    const bounds = detectSilenceBounds(clip.absPath, clipDuration);
    const speechStart = Math.max(words[0].startSec, bounds.leadingSilenceEndSec);
    const speechEnd = Math.min(
      words[words.length - 1].endSec,
      bounds.trailingSilenceStartSec,
    );

    let srcInSec = Math.max(0, speechStart - PAD_SEC);
    let srcOutSec = Math.min(clipDuration, Math.max(speechEnd, speechStart) + PAD_SEC);
    if (block.maxDurationSec !== undefined) {
      srcOutSec = Math.min(srcOutSec, srcInSec + block.maxDurationSec);
    }
    if (srcOutSec - srcInSec < 0.1) {
      // Never emit an unrenderably short block; fall back to the full clip.
      srcInSec = 0;
      srcOutSec = clipDuration;
    }

    blocks.push({ blockId: block.id, srcInSec, srcOutSec });
  }

  return { blocks };
};

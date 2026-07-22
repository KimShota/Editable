import { spawnSync } from "node:child_process";
import { BlockTrim, BoundFile, FilledFormat, Format, TakeTrim, Transcript, TrimPoints, Word } from "./types";

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
 * A multi-take voice block (see transcribe.ts) gets this treatment PER
 * TAKE — each take's own dead air is trimmed independently — which is what
 * makes concatenating them back-to-back read as one continuous clip with
 * no lingering silence at the seams.
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

/** Trims dead air from one take (or a single-clip block, treated as a
 *  one-take block) — the same logic the old single-clip trim() used. */
const trimOneTake = (file: BoundFile, words: Word[]): TakeTrim => {
  const clipDuration = file.durationSec;
  if (clipDuration === undefined) {
    throw new Error(`trim: "${file.path}" has no known duration`);
  }
  if (words.length === 0) {
    // Graceful degradation: no detected speech → pass through as filmed.
    return { srcInSec: 0, srcOutSec: clipDuration };
  }

  const bounds = detectSilenceBounds(file.absPath, clipDuration);
  const speechStart = Math.max(words[0].startSec, bounds.leadingSilenceEndSec);
  const speechEnd = Math.min(words[words.length - 1].endSec, bounds.trailingSilenceStartSec);

  let srcInSec = Math.max(0, speechStart - PAD_SEC);
  let srcOutSec = Math.min(clipDuration, Math.max(speechEnd, speechStart) + PAD_SEC);
  if (srcOutSec - srcInSec < 0.1) {
    // Never emit an unrenderably short take; fall back to the full clip.
    srcInSec = 0;
    srcOutSec = clipDuration;
  }
  return { srcInSec, srcOutSec };
};

/** Cuts a block's total (concatenated) duration down to maxDurationSec by
 *  shortening from the tail of its last take(s) backward — the least
 *  disruptive place to lose time, since it never touches the opening
 *  marker or an earlier take's content. */
const applyMaxDuration = (takes: TakeTrim[], maxDurationSec: number): void => {
  const total = takes.reduce((s, t) => s + (t.srcOutSec - t.srcInSec), 0);
  let over = total - maxDurationSec;
  for (let i = takes.length - 1; i >= 0 && over > 1e-6; i--) {
    const dur = takes[i].srcOutSec - takes[i].srcInSec;
    const cut = Math.min(over, Math.max(0, dur - 0.1));
    takes[i].srcOutSec -= cut;
    over -= cut;
  }
};

export const trim = (
  format: Format,
  filled: FilledFormat,
  transcript: Transcript,
): TrimPoints => {
  const blocks: BlockTrim[] = [];

  for (const block of format.blocks) {
    const clip = filled.bindings[block.videoSlot];

    if (block.kind === "broll") {
      if (clip?.type !== "file" || clip.durationSec === undefined) {
        throw new Error(`trim: block "${block.id}" has no bound clip with a duration`);
      }
      const target = block.brollDurationSec ?? clip.durationSec;
      blocks.push({
        blockId: block.id,
        takes: [{ srcInSec: 0, srcOutSec: Math.min(clip.durationSec, target) }],
      });
      continue;
    }

    const files = clip?.type === "file" ? [clip] : clip?.type === "files" ? clip.files : undefined;
    if (!files) throw new Error(`trim: block "${block.id}" has no bound clip`);

    const blockTranscript = transcript.blocks.find((b) => b.blockId === block.id);
    const takeOrder = blockTranscript?.takeOrder ?? files.map((_, i) => i);
    const takeWords = blockTranscript?.takes ?? files.map(() => []);

    const takes = takeOrder.map((uploadIdx, pos) => trimOneTake(files[uploadIdx], takeWords[pos] ?? []));
    if (block.maxDurationSec !== undefined) applyMaxDuration(takes, block.maxDurationSec);

    blocks.push({ blockId: block.id, takes });
  }

  return { blocks };
};

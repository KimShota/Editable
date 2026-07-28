import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { matchLiteralAnchor } from "./literal";
import { detectSilenceIntervals, trim, trimBrollBlock } from "./trim";
import { transcribe } from "./transcribe";
import { ResolverChoice } from "./resolvers";
import { requireWhisperModel, transcribeFile } from "./whisper";
import {
  Block,
  BlockTranscript,
  BlockTrim,
  FilledFormat,
  Format,
  LiteralAnchor,
  TakeTrim,
  Transcript,
  TrimPoints,
  Word,
} from "./types";

/**
 * Module 3s — Split take (single-continuous-take mode only, i.e. a format
 * with `speakingTakeSlot` set — see schemas.ts's FormatSchema doc comment).
 *
 * Runs whisper ONCE over the whole take, then walks the format's voice
 * blocks in order, using each one's first literal anchor (the same
 * "near-certain block marker" convention orderTakes/trim.ts already rely
 * on) to find where that block's line begins inside the shared file. A
 * block's span runs from its own marker to the NEXT block's marker (or to
 * the end of the take/last detected speech, for the last voice block).
 *
 * This is an auto-split GUESS, same spirit as any anchor fallback
 * elsewhere in this pipeline: never wrong in a way that breaks rendering,
 * just occasionally imprecise — which is exactly what the split UI's
 * draggable handles (see the resources wizard's Step 3) exist to fix.
 *
 * Deliberately does NOT reuse trim.ts's trimOneTake/trimFiller: those
 * assume the WHOLE bound file belongs to one block and trim its own
 * leading/trailing dead air, which is the wrong question here (a block's
 * "clip" is a sub-span in the middle of a much longer shared file). This
 * module answers a different question — "where does this block's span
 * start and end within the shared take" — and produces ordinary
 * Transcript/TrimPoints artifacts so everything downstream (resolveRoles,
 * assemble, render) runs completely unchanged, never knowing the file
 * was shared rather than standalone.
 */

const PAD_SEC = 0.15;
const MIN_SPAN_SEC = 0.3;
/** How far past a block's own last spoken word its srcOutSec may still
 *  reach — see deriveTranscriptAndTrim's clamp. */
const LONG_PAUSE_CLAMP_SEC = 0.25;

export type TakeSplit = {
  blockId: string;
  srcInSec: number;
  srcOutSec: number;
  /** 0 when no literal anchor matched and this block's start fell back to
   *  "right after the previous block ended" — surfaced in the split UI as
   *  a span that especially needs a manual look. */
  confidence: number;
  quote?: string;
};

export type SplitTakeResult = {
  /** Whole-take words, raw take-relative time — kept so a manual
   *  adjustment (or "re-align") can re-slice without re-running whisper. */
  words: Word[];
  durationSec: number;
  blocks: TakeSplit[];
};

const literalAnchorsOf = (block: Block): LiteralAnchor[] =>
  [...block.roles, ...block.anchors].filter((a): a is LiteralAnchor => a.kind === "literal");

/** Complement of merged silence intervals within [0, durationSec] — every
 *  maximal span of real audio (same idea as trim.ts's own speechRegions,
 *  reimplemented locally since that one isn't exported and this module's
 *  use of it is different: whole-take regions, not one block's own). */
const speechRegions = (
  silences: { startSec: number; endSec: number }[],
  durationSec: number,
): { startSec: number; endSec: number }[] => {
  const regions: { startSec: number; endSec: number }[] = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.startSec > cursor) regions.push({ startSec: cursor, endSec: s.startSec });
    cursor = Math.max(cursor, s.endSec);
  }
  if (cursor < durationSec) regions.push({ startSec: cursor, endSec: durationSec });
  return regions;
};

export const splitTake = (format: Format, absPath: string, durationSec: number): SplitTakeResult => {
  requireWhisperModel();

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-split-"));
  let words: Word[];
  try {
    words = transcribeFile(absPath, workDir);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  const silences = detectSilenceIntervals(absPath, durationSec);
  const regions = speechRegions(silences, durationSec);
  const lastSpeechEnd = regions.length > 0 ? regions[regions.length - 1].endSec : durationSec;

  // `optional` voice blocks (a bonus/CTA beat filmed as its OWN separate
  // clip, not part of this continuous take — see BlockSchema's doc
  // comment) are never in the shared take at all; searching it for their
  // marker would at best waste a scan and at worst false-positive match.
  // deriveTranscriptAndTrimWithStandalone handles them separately.
  const voiceBlocks = format.blocks.filter((b) => b.kind === "voice" && !b.optional);
  const starts: Array<{ blockId: string; startSec: number; confidence: number; quote?: string }> = [];

  let searchFloor = 0;
  for (const block of voiceBlocks) {
    const marker = literalAnchorsOf(block)[0];
    const candidateWords = words.filter((w) => w.startSec >= searchFloor);
    const match = marker ? matchLiteralAnchor(marker, candidateWords) : null;
    if (match) {
      const startSec = Math.max(searchFloor, match.startSec - PAD_SEC);
      starts.push({ blockId: block.id, startSec, confidence: match.confidence, quote: match.quote });
      // phraseEndSec, not endSec — a capture anchor's endSec runs however
      // far the greedy capture happened to go, which has nothing to do
      // with where the marker itself sits; using it here let one block's
      // capture swallow the next block's opening words (and, transitively,
      // its own srcOutSec) whenever speech had no clean pause after it.
      searchFloor = match.phraseEndSec;
    } else {
      // No anchor found (silence, or the line wasn't said) — fall back to
      // right where the previous block ended; confidence 0 flags it.
      starts.push({ blockId: block.id, startSec: searchFloor, confidence: 0 });
    }
  }

  const blocks: TakeSplit[] = starts.map((s, i) => {
    const next = starts[i + 1];
    const rawEnd = next ? next.startSec - PAD_SEC : Math.max(lastSpeechEnd, s.startSec + MIN_SPAN_SEC);
    const srcOutSec = Math.min(durationSec, Math.max(rawEnd, s.startSec + MIN_SPAN_SEC));
    return {
      blockId: s.blockId,
      srcInSec: s.startSec,
      srcOutSec,
      confidence: s.confidence,
      quote: s.quote,
    };
  });

  return { words, durationSec, blocks };
};

/**
 * Slices a SplitTakeResult's whole-take words/spans into ordinary
 * Transcript + TrimPoints shapes, one entry per voice block — called both
 * right after auto-split and after a manual handle adjustment, so editing
 * a span never needs to re-run whisper. Every downstream stage consumes
 * these exactly as it would for a standalone per-block clip.
 *
 * Also fills in a TrimPoints (and empty Transcript) entry for every BROLL
 * block, via trim.ts's trimBrollBlock — assemble.ts needs a trim entry for
 * every block in the format, not just the voice ones a shared take covers,
 * and a broll block's clip is bound normally (its own file), never shared.
 */
export const deriveTranscriptAndTrim = (
  format: Format,
  filled: FilledFormat,
  split: SplitTakeResult,
): { transcript: Transcript; trim: TrimPoints } => {
  const transcriptBlocks: BlockTranscript[] = [];
  const trimBlocks: BlockTrim[] = [];
  for (const b of split.blocks) {
    const blockWords = split.words.filter((w) => w.startSec >= b.srcInSec && w.startSec < b.srcOutSec);
    transcriptBlocks.push({ blockId: b.blockId, takeOrder: [0], takes: [blockWords] });
    // Clamp the tail to just after the last word actually spoken in this
    // block — otherwise a long pause before the next block's marker (or
    // before the take's own last detected speech, for the final block)
    // leaves dead air inside the span, and a broll beat cut right after
    // this block lands in that dead air instead of right at the end of
    // speech (the beat-wiring "cuts land exactly at line ends" guarantee).
    // Skipped when no word matched inside the span at all (a confidence-0
    // fallback start) — there's no word timing here to clamp against.
    const lastWordEnd = blockWords.length > 0 ? blockWords[blockWords.length - 1].endSec : undefined;
    const srcOutSec = lastWordEnd !== undefined ? Math.min(b.srcOutSec, lastWordEnd + LONG_PAUSE_CLAMP_SEC) : b.srcOutSec;
    trimBlocks.push({
      blockId: b.blockId,
      takes: [{ srcInSec: b.srcInSec, srcOutSec } satisfies TakeTrim],
    });
  }
  for (const block of format.blocks) {
    if (block.kind !== "broll") continue;
    trimBlocks.push(trimBrollBlock(block, filled));
  }
  return { transcript: { blocks: transcriptBlocks }, trim: { blocks: trimBlocks, diagnostics: [] } };
};

/**
 * deriveTranscriptAndTrim, plus per-block transcribe()/trim() for any
 * `optional` voice block that IS bound (see BlockSchema's doc comment) —
 * a block filmed as its own standalone clip rather than a span of the
 * shared take, so it needs the ordinary multi-clip-format machinery
 * (transcribe.ts/trim.ts), not another split-take span. An optional block
 * left UNBOUND (never filmed) gets no transcript/trim entry at all —
 * assemble.ts skips a block with no trim entry when it's optional, the
 * same "not filmed, not an error" treatment a generated slot's absence
 * already gets elsewhere in this pipeline.
 */
export const deriveTranscriptAndTrimWithStandalone = async (
  format: Format,
  filled: FilledFormat,
  split: SplitTakeResult,
  resolver: ResolverChoice,
): Promise<{ transcript: Transcript; trim: TrimPoints }> => {
  const base = deriveTranscriptAndTrim(format, filled, split);

  const standaloneBlocks = format.blocks.filter(
    (b) => b.kind === "voice" && b.optional && filled.bindings[b.videoSlot],
  );
  if (standaloneBlocks.length === 0) return base;

  const standaloneFormat: Format = { ...format, blocks: standaloneBlocks };
  const standaloneTranscript = transcribe(standaloneFormat, filled);
  const standaloneTrim = await trim(standaloneFormat, filled, standaloneTranscript, resolver);

  return {
    transcript: { blocks: [...base.transcript.blocks, ...standaloneTranscript.blocks] },
    trim: {
      blocks: [...base.trim.blocks, ...standaloneTrim.blocks],
      diagnostics: [...base.trim.diagnostics, ...standaloneTrim.diagnostics],
    },
  };
};

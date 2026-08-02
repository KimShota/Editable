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
 * Module 3s — Split take: runs whenever a job actually binds a
 * speakingTakeSlot (see schemas.ts's FormatSchema doc comment and
 * loader.ts's withImplicitSpeakingTake — most formats offer this as an
 * OPTIONAL alternative to per-block uploads, not a mode the format itself
 * is locked into). Only the voice blocks the take actually covers
 * (isTakeCovered) are split here; any block the user bound with its own
 * clip directly is left alone, so one whole take and a few individually
 * re-filmed lines can be freely mixed in the same job.
 *
 * Runs whisper ONCE over the whole take, then walks the take-covered voice
 * blocks in order, using each one's first literal anchor (the same
 * "near-certain block marker" convention orderTakes/trim.ts already rely
 * on) to find where that block's line begins inside the shared file. A
 * block's span runs from its own marker to the NEXT covered block's marker
 * (or to the end of the take/last detected speech, for the last one).
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

/** A voice block is covered by the shared take when its own clip binding
 *  IS the take — intake.ts clones the take into every non-optional voice
 *  block's own slot that the user didn't bind directly (its
 *  derivedFromTake). Compared by absPath rather than object identity so
 *  this holds across a fresh intake() re-read (e.g. a CLI `--only`
 *  invocation or reassemble), not just within one intake() call. A block
 *  the user bound with its own clip directly — or an `optional` block,
 *  which is never cloned into regardless — is NOT covered, and gets the
 *  ordinary per-block transcribe/trim treatment instead (see
 *  deriveTranscriptAndTrimWithStandalone). */
export const isTakeCovered = (format: Format, filled: FilledFormat, block: Block): boolean => {
  if (block.kind !== "voice" || block.optional || !format.speakingTakeSlot) return false;
  const take = filled.bindings[format.speakingTakeSlot.name];
  const own = filled.bindings[block.videoSlot];
  return take?.type === "file" && own?.type === "file" && own.absPath === take.absPath;
};

/** Whether this job actually supplied a whole take — a format's
 *  speakingTakeSlot may be merely an OPTIONAL alternative to per-block
 *  uploads (see loader.ts's withImplicitSpeakingTake), so its presence on
 *  the format alone doesn't mean this particular job used it. */
export const takeIsBound = (format: Format, filled: FilledFormat): boolean =>
  !!format.speakingTakeSlot && filled.bindings[format.speakingTakeSlot.name]?.type === "file";

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

const scriptWordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, "")
    .split(/\s+/)
    .filter(Boolean);

/**
 * A literal anchor's marker often sits MID-SENTENCE, not at the very start
 * of the line — e.g. "Writing emails? I use Claude.", where the marker
 * phrase is "I use", two words in. That's exactly right for what a literal
 * anchor is used for everywhere else in this pipeline (timing an overlay
 * off where the marker itself falls), but wrong as a BLOCK BOUNDARY here:
 * using match.startSec directly would silently drop the line's own opening
 * clause into the PREVIOUS block's span instead of this one's.
 *
 * When the job wrote this block's line in Step 1 (script.json), this
 * counts how many words the AUTHOR's own text has before its own
 * occurrence of one of the marker's phrases — null when there's no script
 * line for this block, or none of the marker's phrases occur in it (the
 * user free-typed something that doesn't literally contain a suggested
 * marker phrase). backdateToLineStart then walks the ACTUAL transcript
 * back by that many words to find the line's real start.
 *
 * An anchor commonly lists several phrasings of varying length for the
 * SAME marker ("use" / "I use" / "go with" — see one-tool-per-task-
 * rapidfire.json), and more than one can legitimately occur in the
 * author's own line (e.g. both "use" and "I use" are substrings of "I use
 * Claude"). Picking the first one found in phrases-array order would
 * disagree with whichever phrasing matchLiteralAnchor actually matched in
 * the TRANSCRIPT — so this prefers whichever candidate's own word count
 * equals `matchedPhraseWordCount` (how many words the transcript match
 * actually spanned), falling back to the first phrase found only when
 * none matches that length exactly.
 */
export const markerPrecedingWordCount = (
  scriptText: string | undefined,
  marker: LiteralAnchor,
  matchedPhraseWordCount: number,
): number | null => {
  if (!scriptText) return null;
  const lineJoined = ` ${scriptWordsOf(scriptText).join(" ")} `;
  let fallback: number | null = null;
  for (const phrase of marker.phrases) {
    const phraseWords = scriptWordsOf(phrase);
    if (phraseWords.length === 0) continue;
    const idx = lineJoined.indexOf(` ${phraseWords.join(" ")} `);
    if (idx === -1) continue;
    const preceding = lineJoined.slice(0, idx).trim();
    const count = preceding.length === 0 ? 0 : preceding.split(/\s+/).length;
    if (phraseWords.length === matchedPhraseWordCount) return count;
    if (fallback === null) fallback = count;
  }
  return fallback;
};

/** A pause this long between two adjacent transcript words ends the
 *  backward walk early — those words belong to whatever came before
 *  (likely the previous block's own tail, or genuine dead air), not this
 *  block's opening clause. */
const BACKWARD_WALK_PAUSE_SEC = 0.6;

/** Walks backward from the marker's own matched word by up to `wordCount`
 *  words (see markerPrecedingWordCount's doc comment for why) — stopping
 *  early at `floorIdx` (the previous block's own boundary) or a real
 *  pause. Returns the index actually reached: `markerWordIdx` unchanged
 *  when nothing could be walked back over at all, which keeps this
 *  "never wrong in a way that swallows another block's content", only
 *  ever moving the boundary earlier when it's confident. */
export const backdateToLineStart = (words: Word[], markerWordIdx: number, wordCount: number, floorIdx: number): number => {
  let idx = markerWordIdx;
  for (let steps = 0; steps < wordCount && idx > floorIdx; steps++) {
    if (words[idx].startSec - words[idx - 1].endSec > BACKWARD_WALK_PAUSE_SEC) break;
    idx--;
  }
  return idx;
};

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

export const splitTake = (
  format: Format,
  /** Which voice blocks to actually EMIT a span for — production callers
   *  pass exactly what isTakeCovered() says the take fills; a block bound
   *  with its own clip directly (mixed mode) is excluded. Every other
   *  non-optional voice block is still WALKED internally (see the
   *  `starts`/`walkBlocks` doc comment below) so an excluded block's own
   *  content, when the take actually has it, still carves itself out of
   *  the surrounding covered blocks' spans instead of bleeding into them. */
  coveredBlocks: Block[],
  absPath: string,
  durationSec: number,
  /** jobs/<id>/script.json's suggestions, keyed by blockId (see
   *  alignToScript.ts's readScriptSuggestions) — when a block's own line
   *  is known, its marker's mid-sentence position is backdated to the
   *  line's real start (see markerPrecedingWordCount/backdateToLineStart).
   *  Omitted entirely (verify.ts's self-check flow, which has no
   *  script.json) falls back to the marker's own startSec unchanged, the
   *  pre-existing behavior. */
  scriptByBlockId?: Map<string, string>,
  /** Already-computed words for this exact file, combined-file-relative —
   *  passed by orchestrate.ts's runSplit when a multi-clip take binding
   *  produced this file (see prepareTake.ts's TakePrep.words). Skips
   *  re-transcribing a file whisper already saw once per source clip, and
   *  is arguably MORE accurate than transcribing across the concat's own
   *  seams. Omitted (the ordinary single-uploaded-take path, and verify.ts's
   *  self-check) falls back to running whisper on `absPath` as before. */
  precomputedWords?: Word[],
): SplitTakeResult => {
  let words: Word[];
  if (precomputedWords) {
    words = precomputedWords;
  } else {
    requireWhisperModel();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-split-"));
    try {
      words = transcribeFile(absPath, workDir);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  const silences = detectSilenceIntervals(absPath, durationSec);
  const regions = speechRegions(silences, durationSec);
  const lastSpeechEnd = regions.length > 0 ? regions[regions.length - 1].endSec : durationSec;

  // The WALK covers every non-optional voice block in format order —
  // including ones the caller's `coveredBlocks` excludes (mixed mode: a
  // block the user bound with its own clip directly instead of relying on
  // the take). Walking past an excluded block too, not skipping it
  // outright, matters because the take often still CONTAINS that block's
  // real content (the user re-filmed it separately without re-filming the
  // whole take) — if the walk skipped straight over it, the PRECEDING
  // covered block's own emitted span would silently swallow the excluded
  // block's footage instead of stopping before it. Only `coveredBlocks`
  // themselves are actually EMITTED (the `covered` flag below, stripped
  // before returning) — an excluded block just contributes a boundary
  // point when its marker IS found, and is fully transparent (no boundary
  // at all, searchFloor untouched) when it isn't, e.g. an `optional` block
  // never included in the walk at all, or a directly-bound block that
  // truly was never said during the take. An `optional` block (never part
  // of the shared take at all — see BlockSchema's doc comment) is excluded
  // from the walk outright; searching it would at best waste a scan and at
  // worst false-positive match. deriveTranscriptAndTrimWithStandalone
  // handles every excluded block with the ordinary per-block
  // transcribe/trim instead. verify.ts's self-check flow passes every
  // non-optional voice block as `coveredBlocks`, so there's nothing to
  // exclude and this walk is identical to searching coveredBlocks alone.
  const coveredIds = new Set(coveredBlocks.map((b) => b.id));
  const walkBlocks = format.blocks.filter((b) => b.kind === "voice" && !b.optional);
  const starts: Array<{ blockId: string; startSec: number; confidence: number; quote?: string; covered: boolean }> =
    [];

  let searchFloor = 0;
  for (const block of walkBlocks) {
    const covered = coveredIds.has(block.id);
    const marker = literalAnchorsOf(block)[0];
    const candidateWords = words.filter((w) => w.startSec >= searchFloor);
    const match = marker ? matchLiteralAnchor(marker, candidateWords) : null;
    if (match && marker) {
      // The marker's own startSec is right for the FALLBACK case below and
      // for overlay timing elsewhere, but see markerPrecedingWordCount's
      // doc comment for why it's often the wrong BLOCK boundary — backdate
      // to the line's real start when the job's own script says how far.
      // Only matters for an EMITTED block — an excluded one's own start
      // never appears in the output, only its boundary-contribution does.
      let lineStartSec = match.startSec;
      if (covered) {
        const matchedPhraseWordCount = candidateWords.filter(
          (w) => w.startSec >= match.startSec && w.startSec <= match.phraseEndSec,
        ).length;
        const precedingWordCount = markerPrecedingWordCount(
          scriptByBlockId?.get(block.id),
          marker,
          matchedPhraseWordCount,
        );
        if (precedingWordCount !== null && precedingWordCount > 0) {
          const matchedWord = candidateWords.find((w) => w.startSec === match.startSec);
          const markerWordIdx = matchedWord ? words.indexOf(matchedWord) : -1;
          const floorWordIdx = words.findIndex((w) => w.startSec >= searchFloor);
          if (markerWordIdx !== -1) {
            const backdatedIdx = backdateToLineStart(
              words,
              markerWordIdx,
              precedingWordCount,
              floorWordIdx === -1 ? 0 : floorWordIdx,
            );
            lineStartSec = words[backdatedIdx].startSec;
          }
        }
      }

      const startSec = Math.max(searchFloor, lineStartSec - PAD_SEC);
      starts.push({ blockId: block.id, startSec, confidence: match.confidence, quote: match.quote, covered });
      // phraseEndSec, not endSec — a capture anchor's endSec runs however
      // far the greedy capture happened to go, which has nothing to do
      // with where the marker itself sits; using it here let one block's
      // capture swallow the next block's opening words (and, transitively,
      // its own srcOutSec) whenever speech had no clean pause after it.
      searchFloor = match.phraseEndSec;
    } else if (covered) {
      // No anchor found (silence, or the line wasn't said) — fall back to
      // right where the previous block ended; confidence 0 flags it. An
      // EXCLUDED block with no match contributes nothing at all (not even
      // a placeholder): there's no real boundary to anchor on, so it's as
      // if this block weren't walked in the first place.
      starts.push({ blockId: block.id, startSec: searchFloor, confidence: 0, covered: true });
    }
  }

  const blocks: TakeSplit[] = starts
    .map((s, i): TakeSplit & { covered: boolean } => {
      const next = starts[i + 1];
      const rawEnd = next ? next.startSec - PAD_SEC : Math.max(lastSpeechEnd, s.startSec + MIN_SPAN_SEC);
      const srcOutSec = Math.min(durationSec, Math.max(rawEnd, s.startSec + MIN_SPAN_SEC));
      return {
        blockId: s.blockId,
        srcInSec: s.startSec,
        srcOutSec,
        confidence: s.confidence,
        quote: s.quote,
        covered: s.covered,
      };
    })
    .filter((b) => b.covered)
    .map((b): TakeSplit => ({ blockId: b.blockId, srcInSec: b.srcInSec, srcOutSec: b.srcOutSec, confidence: b.confidence, quote: b.quote }));

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
 * deriveTranscriptAndTrim, plus per-block transcribe()/trim() for every
 * bound voice block the take does NOT cover (!isTakeCovered) — either an
 * `optional` block filmed as its own standalone clip (see BlockSchema's
 * doc comment), or, in a MIXED job, an ordinary block the user chose to
 * film separately and bind directly instead of relying on the shared take.
 * Either way it needs the ordinary multi-clip-format machinery
 * (transcribe.ts/trim.ts), not another split-take span. A voice block left
 * entirely UNBOUND gets no transcript/trim entry at all — harmless only
 * when it's `optional` (assemble.ts skips a block with no trim entry in
 * that case, the same "not filmed, not an error" treatment a generated
 * slot's absence already gets elsewhere in this pipeline); a required
 * block reaching this point unbound would already have failed intake().
 */
export const deriveTranscriptAndTrimWithStandalone = async (
  format: Format,
  filled: FilledFormat,
  split: SplitTakeResult,
  resolver: ResolverChoice,
): Promise<{ transcript: Transcript; trim: TrimPoints }> => {
  const base = deriveTranscriptAndTrim(format, filled, split);

  const standaloneBlocks = format.blocks.filter(
    (b) => b.kind === "voice" && filled.bindings[b.videoSlot] && !isTakeCovered(format, filled, b),
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

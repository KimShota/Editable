import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { matchLiteralAnchor } from "./literal";
import { detectSilenceIntervals, trim, trimBrollBlock } from "./trim";
import { transcribe } from "./transcribe";
import { ResolverChoice } from "./resolvers";
import { requireWhisperModel, transcribeFile } from "./whisper";
import { wordSimilarity } from "./alignToScript";
import { buildScriptWordIndex, fitAlign, FitResult, MIN_ALIGN_SCORE } from "./prepareTake";
import {
  Block,
  BlockTranscript,
  BlockTrim,
  FilledFormat,
  Format,
  LiteralAnchor,
  TakePrep,
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
  /** 0 (or, for the multi-clip utterance fallback, a low fixed value — see
   *  UTTERANCE_FALLBACK_CONFIDENCE) when no confident match was found and
   *  this span is a guess — surfaced in the split UI (confidence < 0.5) as
   *  a span that especially needs a manual look. */
  confidence: number;
  quote?: string;
  /** Job-relative path to the ORIGINAL uploaded clip this segment's span
   *  was found in — set only by splitMultiClipTake (a single-clip take, the
   *  ordinary case, leaves this undefined; srcInSec/srcOutSec are already
   *  unambiguous with exactly one segment per block). The split UI groups
   *  segments into one panel per clipPath so "check this line" means
   *  checking it against the actual footage it was found in, not a
   *  concatenated file the block boundaries can't line up with (see this
   *  module's own doc comment on why splitMultiClipTake exists at all).
   *  srcInSec/srcOutSec always stay in COMBINED-file time regardless —
   *  only the grouping key changes; every downstream consumer
   *  (deriveTranscriptAndTrim, assemble.ts) keeps working against the one
   *  shared combined file exactly as before. */
  clipPath?: string;
};

/** Bumped whenever this module's OWN output shape changes in a way that
 *  invalidates an existing splitTake.json — e.g. adding clipPath/multi-
 *  segment-per-block support here. orchestrate.ts's readSplit discards a
 *  cached split whose version doesn't match, so an old job transparently
 *  gets a fresh auto-split next time its resources page loads, rather than
 *  the split UI trying to render a shape it no longer understands. */
export const SPLIT_PIPELINE_VERSION = "2";

export type SplitTakeResult = {
  /** Whole-take words, raw take-relative time — kept so a manual
   *  adjustment (or "re-align") can re-slice without re-running whisper. */
  words: Word[];
  durationSec: number;
  blocks: TakeSplit[];
  pipelineVersion: string;
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

  return { words, durationSec, blocks, pipelineVersion: SPLIT_PIPELINE_VERSION };
};

// ---------------------------------------------------------------------------
// Multi-clip split — one auto-split PER ORIGINAL CLIP instead of one walk
// across the combined file (see prepareTake.ts and splitMultiClipTake's own
// doc comment below for why the single-walk approach above can't work when
// a "take" is actually several separately-filmed clips, each covering only
// a FRAGMENT of every line rather than a few whole lines each).
// ---------------------------------------------------------------------------

/** Whisper wraps a non-lexical sound in literal parentheses — "(clears
 *  throat)", "(laughs)" — never real script content. Filtered out before
 *  counting utterances below so a leading throat-clear doesn't throw off
 *  "does this clip's utterance count match the number of lines" (a false
 *  start would otherwise silently add one bogus utterance and make an
 *  otherwise-clean 1:1 mapping look like a mismatch). */
const isNonVerbalUtterance = (words: Word[]): boolean => /[()]/.test(words.map((w) => w.text).join(""));

/** How long a gap between two consecutive whisper words has to be to read
 *  as the boundary between two separately-spoken LINES, for a clip whose
 *  own whole-clip script alignment wasn't confident enough to trust word-
 *  for-word (see splitClipRanges). Comfortably above ordinary word-to-word
 *  timing within one phrase (0s within any word measured while building
 *  this) and comfortably below the shortest real between-line pause
 *  observed in practice (>1.4s) — a clip that simply names one tool after
 *  another, one per line, reads as a clean run of short bursts separated
 *  by long silences. */
const UTTERANCE_GAP_SEC = 0.8;

/** Fixed confidence assigned to every span the utterance fallback produces
 *  — well under the split UI's own <0.5 "needs a look" threshold (same
 *  spirit as this module's own confidence-0 fallback above), since a
 *  positional guess is exactly that, not a real match. */
const UTTERANCE_FALLBACK_CONFIDENCE = 0.3;

type Utterance = { words: Word[]; startSec: number; endSec: number };

/** Groups a clip's own words into runs separated by a UTTERANCE_GAP_SEC+
 *  silence — the pause-based fallback's unit of "one spoken line", used
 *  when this clip's whole-take alignment against the script wasn't
 *  confident enough to trust (see MIN_ALIGN_SCORE). */
const utterancesOf = (words: Word[]): Utterance[] => {
  const utterances: Utterance[] = [];
  let current: Word[] = [];
  for (const w of words) {
    const prev = current[current.length - 1];
    if (prev && w.startSec - prev.endSec > UTTERANCE_GAP_SEC) {
      utterances.push({ words: current, startSec: current[0].startSec, endSec: prev.endSec });
      current = [];
    }
    current.push(w);
  }
  if (current.length > 0) {
    utterances.push({ words: current, startSec: current[0].startSec, endSec: current[current.length - 1].endSec });
  }
  return utterances;
};

/** One block's own word range within a single clip, clip-relative seconds
 *  — the shared intermediate shape both segmentation strategies below
 *  produce, before padRangesToSegments turns adjacent ranges into
 *  non-overlapping cut spans. */
type ClipRange = { blockId: string; startSec: number; endSec: number; confidence: number };

/**
 * Word-level alignment strategy: fits this clip's own words against the
 * SAME concatenated script reference prepareTake.ts's ensureTakePrep used
 * to place the clip in the first place (buildScriptWordIndex), then groups
 * the matched word pairs by which block each matched script word belongs
 * to. Reliable exactly when the clip's WHOLE-clip fit score already cleared
 * MIN_ALIGN_SCORE (checked by the caller) — a clip that scored well overall
 * has clean, mostly-correct per-word matches to group by.
 */
const alignmentRanges = (
  clipWords: Word[],
  fit: FitResult,
  scriptWordIndex: { words: string[]; blockIds: string[] },
): ClipRange[] | null => {
  if (fit.pairs.length === 0) return null;

  const byBlock = new Map<string, { clipIndex: number; scriptIndex: number }[]>();
  for (const p of fit.pairs) {
    const blockId = scriptWordIndex.blockIds[p.scriptIndex];
    if (!byBlock.has(blockId)) byBlock.set(blockId, []);
    byBlock.get(blockId)!.push(p);
  }

  const ranges: ClipRange[] = [...byBlock.entries()].map(([blockId, pairs]) => {
    const clipIdxs = pairs.map((p) => p.clipIndex).sort((a, b) => a - b);
    const similarity =
      pairs.reduce((sum, p) => sum + wordSimilarity(clipWords[p.clipIndex].text, scriptWordIndex.words[p.scriptIndex]), 0) /
      pairs.length;
    return {
      blockId,
      startSec: clipWords[clipIdxs[0]].startSec,
      endSec: clipWords[clipIdxs[clipIdxs.length - 1]].endSec,
      confidence: similarity,
    };
  });
  ranges.sort((a, b) => a.startSec - b.startSec);
  return ranges;
};

/**
 * Pause-based fallback strategy for a clip whose whole-clip alignment
 * wasn't confident (e.g. whisper mishears every brand name in a clip of
 * back-to-back tool names — a real case: "Claude" transcribed as "Quad",
 * "Grok" as "Grock", "NotebookLM" as "Note book and learn"). Rather than
 * trust word-for-word matching against text whisper got largely wrong,
 * this only trusts the ACOUSTIC shape of the clip: if it breaks into
 * exactly as many pause-separated utterances as the format has lines, each
 * utterance almost certainly IS one line, spoken in the same order the
 * format lists them — map them 1:1 positionally, no text matching at all.
 * Returns null (nothing usable) when the count doesn't match; a caller
 * with no better guess for this clip then simply gets no segments from it
 * rather than a wrong one (same "never wrong in a way that breaks
 * rendering" precedent as this module's own confidence-0 fallback above).
 */
const utteranceRanges = (clipWords: Word[], walkBlockIds: string[]): ClipRange[] | null => {
  const utterances = utterancesOf(clipWords).filter((u) => !isNonVerbalUtterance(u.words));
  if (utterances.length !== walkBlockIds.length) return null;
  return utterances.map((u, i) => ({
    blockId: walkBlockIds[i],
    startSec: u.startSec,
    endSec: u.endSec,
    confidence: UTTERANCE_FALLBACK_CONFIDENCE,
  }));
};

/** Turns an ordered-by-startSec, one-range-per-block list into padded,
 *  overlap-free cut spans: the boundary between two adjacent ranges lands
 *  exactly on the MIDPOINT of the silence between them (never encroaching
 *  on a neighbor, however little padding that leaves), padded out from
 *  each range's own words by up to PAD_SEC when the gap allows it. The
 *  outermost edges (no neighbor on that side) pad freely against
 *  lowerBoundSec/upperBoundSec — this clip's own edge-trimmed window (see
 *  TakePrepClip.srcInSec/srcOutSec), not the raw file, since anything
 *  outside that window was never cut into the combined file at all. */
const padRangesToSegments = (
  ranges: ClipRange[],
  lowerBoundSec: number,
  upperBoundSec: number,
): { blockId: string; srcInSec: number; srcOutSec: number; confidence: number }[] =>
  ranges.map((r, i) => {
    const prev = ranges[i - 1];
    const next = ranges[i + 1];
    const leftBound = prev ? (prev.endSec + r.startSec) / 2 : lowerBoundSec;
    const rightBound = next ? (r.endSec + next.startSec) / 2 : upperBoundSec;
    const srcInSec = Math.max(leftBound, r.startSec - PAD_SEC);
    const srcOutSec = Math.max(srcInSec + 0.05, Math.min(rightBound, r.endSec + PAD_SEC));
    return { blockId: r.blockId, srcInSec, srcOutSec, confidence: r.confidence };
  });

/**
 * Module 3s, multi-clip variant — runs when a speakingTakeSlot binding is
 * several separately-filmed clips (prepareTake.ts's TakePrep) rather than
 * one continuous recording. splitTake's own single walk above assumes each
 * covered block's content appears ONCE, contiguously, somewhere in the
 * take — an assumption a multi-clip take can break outright: e.g. one clip
 * recorded naming only the TASK half of every line ("Writing emails,
 * brainstorming ideas, …") and a second recorded naming only the TOOL half
 * ("Claude. ChatGPT. …"), so every single block's line is split across
 * BOTH clips, not contained in either one. A linear walk across the
 * concatenated combined file simply cannot represent that; this instead
 * splits EACH ORIGINAL CLIP independently (segmentClipRanges below) and
 * lets a block end up with as many segments as clips actually contributed
 * to it — deriveTranscriptAndTrim already knows how to concatenate several
 * segments for one block (the same multi-take machinery a block filmed as
 * several standalone takes already uses), so nothing downstream of this
 * function needs to know the take was ever split apart.
 *
 * Segment times are still COMBINED-file-relative, same as the single-walk
 * path — only the SOURCE this function searches (one clip's own words at a
 * time, not the concatenated whole) and the fact that one block can now
 * emit more than one segment are new. Each segment also records which
 * ORIGINAL clip it came from (TakeSplit.clipPath), purely for the split
 * UI's own grouping — nothing in deriveTranscriptAndTrim/assemble reads it.
 */
export const splitMultiClipTake = (
  format: Format,
  coveredBlocks: Block[],
  takePrep: TakePrep,
  scriptByBlockId: Map<string, string> | undefined,
): SplitTakeResult => {
  const coveredIds = new Set(coveredBlocks.map((b) => b.id));
  const walkBlocks = format.blocks.filter((b) => b.kind === "voice" && !b.optional);
  const walkBlockIds = walkBlocks.map((b) => b.id);
  const scriptWordIndex = scriptByBlockId ? buildScriptWordIndex(format, scriptByBlockId) : { words: [], blockIds: [] };

  const keptClips = takePrep.clips.filter((c) => c.ordering !== "excluded");
  const clipScriptStart = new Map(keptClips.map((c) => [c.input.path, c.scriptStartIdx ?? Number.MAX_SAFE_INTEGER]));

  const blocks: TakeSplit[] = [];
  for (const clip of keptClips) {
    const clipWords = clip.words.filter((w) => w.startSec >= clip.srcInSec && w.startSec < clip.srcOutSec);
    if (clipWords.length === 0) continue;

    let ranges: ClipRange[] | null = null;
    if (scriptWordIndex.words.length > 0) {
      const fit = fitAlign(
        clipWords.map((w) => w.text),
        scriptWordIndex.words,
      );
      if (fit && fit.score >= MIN_ALIGN_SCORE) ranges = alignmentRanges(clipWords, fit, scriptWordIndex);
    }
    if (!ranges) ranges = utteranceRanges(clipWords, walkBlockIds);
    if (!ranges) continue; // nothing usable from this clip — see utteranceRanges' own doc comment

    const segments = padRangesToSegments(ranges, clip.srcInSec, clip.srcOutSec).filter((s) => coveredIds.has(s.blockId));
    for (const s of segments) {
      blocks.push({
        blockId: s.blockId,
        srcInSec: s.srcInSec - clip.srcInSec + clip.offsetSec,
        srcOutSec: s.srcOutSec - clip.srcInSec + clip.offsetSec,
        confidence: s.confidence,
        clipPath: clip.input.path,
      });
    }
  }

  // A block with more than one segment gets concatenated by
  // deriveTranscriptAndTrim in the ORDER its segments appear here (see that
  // function's own doc comment) — so segments for the same block need to
  // land in the order the LINE actually reads, not the order their source
  // clips happen to sit in the combined file (the clip placed first by
  // prepareTake.ts is whichever one aligned least confidently, which has
  // nothing to do with which half of the line it says). Each kept clip's
  // own scriptStartIdx (its rough position in the whole concatenated
  // script, computed once by prepareTake.ts regardless of whether that
  // placement was "confident") is a reasonable proxy for "which part of
  // each line this clip covers".
  //
  // Grouped by blockId (first-seen order preserved) and each group sorted
  // independently, rather than one Array.sort over the whole flat list
  // with a comparator that returns 0 across different blockIds — that
  // comparator isn't transitive (it can say tool > task for one block's
  // pair while treating an unrelated block's segment as "equal" to both),
  // which makes plain Array.sort's result unspecified, not merely
  // "unsorted"; splitting into real groups first sidesteps that entirely.
  const orderedBlockIds: string[] = [];
  const byBlockId = new Map<string, TakeSplit[]>();
  for (const b of blocks) {
    if (!byBlockId.has(b.blockId)) {
      byBlockId.set(b.blockId, []);
      orderedBlockIds.push(b.blockId);
    }
    byBlockId.get(b.blockId)!.push(b);
  }
  const orderedBlocks: TakeSplit[] = orderedBlockIds.flatMap((blockId) => {
    const segs = byBlockId.get(blockId)!;
    segs.sort((a, b) => (clipScriptStart.get(a.clipPath!) ?? 0) - (clipScriptStart.get(b.clipPath!) ?? 0));
    return segs;
  });

  return {
    words: takePrep.words,
    durationSec: takePrep.combinedDurationSec,
    blocks: orderedBlocks,
    pipelineVersion: SPLIT_PIPELINE_VERSION,
  };
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
  // A block usually gets exactly one segment (the ordinary single-walk
  // split above), but splitMultiClipTake can emit SEVERAL for one block —
  // one per contributing clip (see its own doc comment). Grouped by
  // blockId, in the order split.blocks already lists them (that order is
  // itself meaningful for a multi-segment block — see
  // splitMultiClipTake's own sort), into the SAME multi-take shape a block
  // filmed as several standalone takes already produces (BlockTranscript.
  // takes/BlockTrim.takes are always arrays) — so assemble.ts's existing
  // multi-take concatenation (one video segment per take, laid back to
  // back) handles this with no changes of its own, same as
  // concatenateTakes for captions.
  const wordsByBlock = new Map<string, Word[][]>();
  const takesByBlock = new Map<string, TakeTrim[]>();
  for (const b of split.blocks) {
    const blockWords = split.words.filter((w) => w.startSec >= b.srcInSec && w.startSec < b.srcOutSec);
    if (!wordsByBlock.has(b.blockId)) wordsByBlock.set(b.blockId, []);
    wordsByBlock.get(b.blockId)!.push(blockWords);

    // Clamp the tail to just after the last word actually spoken in this
    // segment — otherwise a long pause before the next boundary (the next
    // block's marker, the next segment of the SAME block, or the take's
    // own last detected speech for the final one) leaves dead air inside
    // the span, and a broll beat cut right after this block lands in that
    // dead air instead of right at the end of speech (the beat-wiring
    // "cuts land exactly at line ends" guarantee). Skipped when no word
    // matched inside the span at all (a confidence-0 fallback start) —
    // there's no word timing here to clamp against.
    const lastWordEnd = blockWords.length > 0 ? blockWords[blockWords.length - 1].endSec : undefined;
    const srcOutSec = lastWordEnd !== undefined ? Math.min(b.srcOutSec, lastWordEnd + LONG_PAUSE_CLAMP_SEC) : b.srcOutSec;
    if (!takesByBlock.has(b.blockId)) takesByBlock.set(b.blockId, []);
    takesByBlock.get(b.blockId)!.push({ srcInSec: b.srcInSec, srcOutSec });
  }

  const transcriptBlocks: BlockTranscript[] = [...wordsByBlock.entries()].map(([blockId, takes]) => ({
    blockId,
    // Every take here comes from the SAME shared take file (splitTake's
    // whole point), so there's only ever one underlying source file for
    // assemble.ts's takeFiles to index into — takeOrder is all zeros
    // regardless of how many segments this block has.
    takeOrder: takes.map(() => 0),
    takes,
  }));
  const trimBlocks: BlockTrim[] = [...takesByBlock.entries()].map(([blockId, takes]) => ({ blockId, takes }));

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

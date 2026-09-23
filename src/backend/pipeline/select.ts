import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { matchLiteralAnchor } from "./literal";
import { detectSilenceIntervals, speechRegions, SpeechRegion } from "./trim";
import { isNonVerbalUtterance } from "./splitTake";
import { fitAlign } from "./prepareTake";
import { requireWhisperModel, transcribeFile } from "./whisper";
import { pickSelector, ResolverChoice } from "./resolvers";
import { SelectionResolver } from "./resolvers/selectionProtocol";
import {
  Block,
  BlockTranscript,
  BlockTrim,
  BoundFile,
  FilledFormat,
  Format,
  LiteralAnchor,
  Selection,
  SelectionUtterance,
  TakeTrim,
  Transcript,
  TrimPoints,
  Word,
} from "./types";

/**
 * Module 3.5 — Select (runs between trim and matte).
 *
 * trim.ts only ever moves a take's two OUTER edges inward — "the middle of
 * a take is never touched" by design (see its own doc comment). That's
 * exactly right for dead air and edge filler, but leaves a real problem
 * untouched: a line said twice inside one recording, a false start
 * completed later, or "okay, wait, let me try that again" in the middle
 * of a take all survive straight into the render. This stage finds and
 * removes exactly that, working entirely on trim's OWN output (each
 * take's already-narrowed [srcInSec, srcOutSec) span) so the two stages
 * compose cleanly: trim answers "where does this file's real content
 * start and end", select answers "which of what's left actually belongs
 * in the final line".
 *
 * Method, per voice block:
 *   1. Within each take's trimmed span, split the audio into UTTERANCES —
 *      maximal speech regions separated by a pause >= UTTERANCE_GAP_SEC —
 *      using the same audio-grounded silence detection trim.ts already
 *      uses (detectSilenceIntervals/speechRegions), never whisper's own
 *      timestamps, for the same reason trim.ts avoids them (unreliable
 *      right at a boundary).
 *   2. Transcribe each utterance ON ITS OWN (cut its audio, run whisper
 *      fresh) rather than reusing the take's whole-file transcript — a
 *      short, silence-bounded clip gives whisper a clean onset instead of
 *      words smeared across the pause the way a single whole-take pass
 *      sometimes does (this is what fixed vyra-website's round-numbered
 *      timestamps in testing).
 *   3. Decide keep/drop per utterance, across every take/file in the
 *      block in playback order (see decideKeep): a heuristic ALWAYS runs
 *      (filler-word match, or a later utterance that closely matches an
 *      earlier one — a retake or a completed false start, later wins); an
 *      LLM resolver, when available, can override a verdict but only with
 *      real confidence, same "floor under the resolver, not a fallback
 *      for when it's merely absent" contract trim.ts's own filler check
 *      uses. An utterance containing a literal anchor phrase is always
 *      protected, same guard trim.ts's filler pass already applies.
 *   4. Kept utterances become new TakeTrim ranges (one per contiguous run
 *      — two adjacent utterances with nothing dropped between them merge
 *      back into ONE span, so an ordinary mid-sentence thinking pause
 *      never becomes a visible cut), padded and clamped against their own
 *      immediate neighbors exactly like splitTake.ts's own
 *      padRangesToSegments. The matching transcript words are pre-filtered
 *      to each range (never re-including a dropped utterance's own text),
 *      avoiding the duplicated-word problem concatenateTakesForMatching
 *      otherwise has to work around.
 *
 * Output is the SAME BlockTranscript/BlockTrim shape a block filmed as
 * several standalone takes, or split from a shared take
 * (splitTake.deriveTranscriptAndTrim), already produces — TakeTrim/
 * BlockTranscript.takes are always arrays — so nothing downstream
 * (matte, backgroundReplace, resolveRoles, assemble) needs to change to
 * consume several ranges from one block; that machinery already exists.
 *
 * Explicitly OUT OF SCOPE, passed through unchanged:
 *   - broll blocks (nothing to transcribe/select against).
 *   - a block flagged backgroundReplace/plateComposite/silhouette — those
 *     stages (matte.ts, backgroundReplace.ts) only handle ONE range per
 *     block today; expanding that is a separate change.
 *   - a take with hasUsableVideo:false (a voice-only recording from a
 *     multi-clip speakingTakeSlot split) — narrow, already-correct
 *     machinery in assemble.ts this stage isn't worth complicating.
 */

const UTTERANCE_GAP_SEC = 0.45;
/** Kept neighbors with a gap at most this long merge into ONE range —
 *  deliberately >= UTTERANCE_GAP_SEC so a genuine mid-delivery pause that
 *  splits into two utterances, when BOTH survive selection, silently
 *  reunites into one continuous span with no cut — only a genuinely
 *  DROPPED utterance in between ever produces a visible jump cut. */
const MERGE_GAP_SEC = 0.7;
const PAD_BEFORE_SEC = 0.12;
const PAD_AFTER_SEC = 0.2;
/** Below this confidence, a resolver's verdict for one utterance is
 *  discarded (the heuristic's own verdict stands) — mirrors trim.ts's own
 *  FILLER_CONFIDENCE_THRESHOLD. */
const SELECT_CONFIDENCE_THRESHOLD = 0.6;
/** An utterance-pair similarity at or above this reads as "the same
 *  content" (a retake, or a false start completed later) — see
 *  utteranceSimilarity. */
const RETAKE_SIMILARITY_THRESHOLD = 0.6;
/** An utterance shorter than this many words is too short for the retake
 *  comparison to trust. 1 (not higher) deliberately: a one-word sign-off
 *  ("Bye.") said several times back to back is a completely ordinary real
 *  case, and fitAlign's own scoring already guards the false-positive risk
 *  a lower bound would exist to prevent — a short utterance only scores
 *  high against a LONGER one when its own word(s) match with real
 *  similarity, not merely by being short. */
const MIN_WORDS_FOR_RETAKE_COMPARISON = 1;

const FILLER_WORDS = new Set([
  "um", "umm", "uh", "uhh", "erm", "hm", "hmm", "huh",
  "okay", "ok", "kay", "cool", "so", "yeah", "yep", "yup",
  "alright", "right", "like", "well", "anyway", "anyways", "wait", "sorry",
  "again", "redo", "retake",
]);
const FILLER_WORD_MAX_COUNT = 6;
const FILLER_WORD_FRACTION = 0.8;

const normalizeWord = (raw: string): string => raw.toLowerCase().replace(/[^a-z']/g, "");

const looksLikeFillerHeuristic = (words: Word[]): boolean => {
  if (words.length === 0 || words.length > FILLER_WORD_MAX_COUNT) return false;
  const fillerCount = words.filter((w) => FILLER_WORDS.has(normalizeWord(w.text))).length;
  return fillerCount / words.length >= FILLER_WORD_FRACTION;
};

const literalAnchorsOf = (block: Block): LiteralAnchor[] =>
  [...block.roles, ...block.anchors].filter((a): a is LiteralAnchor => a.kind === "literal");

const chunkHoldsAnAnchor = (words: Word[], anchors: LiteralAnchor[]): boolean =>
  anchors.some((a) => matchLiteralAnchor(a, words) !== null);

const videoSlotInstructions = (block: Block): string =>
  block.slots.find((s) => s.name === block.videoSlot)?.instructions ?? block.title;

// ---------------------------------------------------------------------------
// Utterance construction
// ---------------------------------------------------------------------------

/** Exported for tools/selectRobustness.ts, which drives decideKeep()
 *  directly against synthetic utterances (no ffmpeg/whisper involved). */
export type Utterance = {
  /** Stable id for this utterance — "<file path>#<file utterance index>". */
  id: string;
  blockId: string;
  /** Index into the block's own bound files (upload order), not playback
   *  position. */
  fileIdx: number;
  /** This utterance's own position within ITS FILE's ordered utterance
   *  list (perFileUtterances below) — used to detect "nothing was
   *  dropped between these two kept utterances" when merging ranges. */
  fileUtteranceIndex: number;
  /** File-relative raw seconds, unpadded. */
  srcInSec: number;
  srcOutSec: number;
  /** File-relative absolute seconds (already re-transcribed, NOT the
   *  original whole-take words). */
  words: Word[];
};

/** Cuts one region's audio and transcribes it fresh — see this file's own
 *  doc comment (step 2) for why a fresh per-utterance pass beats reusing
 *  the whole-take transcript. Returns words shifted back to file-relative
 *  seconds. */
const transcribeRegion = (absPath: string, startSec: number, endSec: number): Word[] => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-select-"));
  try {
    const wav = path.join(workDir, "region.wav");
    execFileSync(
      "ffmpeg",
      [
        "-y", "-v", "error",
        "-ss", startSec.toFixed(3),
        "-to", endSec.toFixed(3),
        "-i", absPath,
        "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
        wav,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    const words = transcribeFile(wav, workDir);
    return words.map((w) => ({ text: w.text, startSec: w.startSec + startSec, endSec: w.endSec + startSec }));
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

/** Every utterance found in one take's own already-trimmed span, in time
 *  order, independently transcribed. */
const utterancesForTake = (
  blockId: string,
  file: BoundFile,
  fileIdx: number,
  take: TakeTrim,
): Utterance[] => {
  const duration = file.durationSec;
  if (duration === undefined) return [];

  const silences = detectSilenceIntervals(file.absPath, duration);
  const regions = speechRegions(silences, duration)
    .filter((r) => r.endSec > take.srcInSec && r.startSec < take.srcOutSec)
    .map((r): SpeechRegion => ({
      startSec: Math.max(r.startSec, take.srcInSec),
      endSec: Math.min(r.endSec, take.srcOutSec),
    }));

  const groups: SpeechRegion[] = [];
  for (const r of regions) {
    const prev = groups[groups.length - 1];
    if (prev && r.startSec - prev.endSec <= UTTERANCE_GAP_SEC) {
      prev.endSec = r.endSec;
    } else {
      groups.push({ ...r });
    }
  }

  const utterances: Utterance[] = [];
  for (const g of groups) {
    if (g.endSec - g.startSec < 0.08) continue; // too short to be real content
    const words = transcribeRegion(file.absPath, g.startSec, g.endSec);
    if (words.length === 0 || isNonVerbalUtterance(words)) continue;
    utterances.push({
      id: `${file.path}#${utterances.length}`,
      blockId,
      fileIdx,
      fileUtteranceIndex: utterances.length,
      srcInSec: g.startSec,
      srcOutSec: g.endSec,
      words,
    });
  }
  return utterances;
};

// ---------------------------------------------------------------------------
// Keep/drop decision
// ---------------------------------------------------------------------------

export type SelectDecision = { keep: boolean; reason: string; source: "heuristic" | "resolver" };

/** How closely two utterances' own content matches — symmetric: fits the
 *  SHORTER one's words against the longer one's (free to start/end
 *  anywhere inside it — prepareTake.ts's own semi-global alignment),
 *  normalized over the shorter's own length. High for a retake (near-
 *  identical content) AND for a false start (the short one's words are a
 *  clean prefix of the long one's). */
const utteranceSimilarity = (a: Word[], b: Word[]): number => {
  const aText = a.map((w) => w.text);
  const bText = b.map((w) => w.text);
  const [shortWords, longWords] = aText.length <= bText.length ? [aText, bText] : [bText, aText];
  if (shortWords.length < MIN_WORDS_FOR_RETAKE_COMPARISON) return 0;
  const fit = fitAlign(shortWords, longWords);
  return fit ? fit.score : 0;
};

/** Decides keep/drop for every utterance in a block, across every take in
 *  playback order. Exported (alongside the types above it depends on)
 *  purely so tools/selectRobustness.ts can drive it directly against
 *  synthetic utterances — no ffmpeg/whisper involved in that path. */
export const decideKeep = async (
  utterances: Utterance[],
  instructions: string,
  anchors: LiteralAnchor[],
  resolver: SelectionResolver | null,
): Promise<Map<string, SelectDecision>> => {
  const decisions = new Map<string, SelectDecision>();

  // 1. Filler heuristic — always runs, sets the default verdict.
  for (const u of utterances) {
    decisions.set(
      u.id,
      looksLikeFillerHeuristic(u.words)
        ? { keep: false, reason: "heuristic: filler/aside", source: "heuristic" }
        : { keep: true, reason: "heuristic: kept", source: "heuristic" },
    );
  }

  // 2. Retake / false-start: an earlier utterance closely matched by a
  //    LATER one is superseded — later wins (people warm up).
  for (let i = 0; i < utterances.length; i++) {
    if (decisions.get(utterances[i].id)!.keep === false) continue;
    for (let j = i + 1; j < utterances.length; j++) {
      const sim = utteranceSimilarity(utterances[i].words, utterances[j].words);
      if (sim >= RETAKE_SIMILARITY_THRESHOLD) {
        decisions.set(utterances[i].id, {
          keep: false,
          reason: `heuristic: superseded by a later, closely-matching utterance (similarity ${sim.toFixed(2)})`,
          source: "heuristic",
        });
        break;
      }
    }
  }

  // 3. Guard: an utterance holding a literal anchor phrase is protected —
  //    the block's own structure depends on it surviving — UNLESS a later
  //    utterance holds the SAME anchor too (then only that later one needs
  //    protecting; the earlier one may still be a legitimate retake).
  for (let i = 0; i < utterances.length; i++) {
    const u = utterances[i];
    if (!chunkHoldsAnAnchor(u.words, anchors)) continue;
    const laterAlsoHolds = utterances.slice(i + 1).some((v) => chunkHoldsAnAnchor(v.words, anchors));
    if (!laterAlsoHolds) {
      decisions.set(u.id, { keep: true, reason: "guard: contains a literal anchor phrase", source: "heuristic" });
    }
  }

  // 4. Optional LLM pass — one call per block, sees every utterance at
  //    once (unlike trim.ts's edge-only check, there's no fixed "first/
  //    last" position here). Only overrides at real confidence; never
  //    lets a confident resolver drop an anchor-bearing utterance the
  //    guard above just protected.
  if (resolver && utterances.length > 1) {
    try {
      const verdicts = await resolver.selectBlock({
        blockId: utterances[0].blockId,
        instructions,
        utterances: utterances.map((u) => ({ id: u.id, text: u.words.map((w) => w.text).join(" ") })),
      });
      for (const v of verdicts) {
        if (v.confidence < SELECT_CONFIDENCE_THRESHOLD) continue;
        const u = utterances.find((x) => x.id === v.id);
        if (!u) continue;
        if (!v.keep && chunkHoldsAnAnchor(u.words, anchors)) continue;
        decisions.set(v.id, { keep: v.keep, reason: `resolver: ${v.reason} (${v.confidence.toFixed(2)})`, source: "resolver" });
      }
    } catch (err) {
      // Degrade to the heuristic verdicts already set — same "a down/broken
      // resolver degrades to dumber selection, never to no selection"
      // contract trim.ts's own filler check follows.
      console.warn(`select: resolver failed for block "${utterances[0].blockId}" (${(err as Error).message}) — using heuristic verdicts`);
    }
  }

  // 5. Never drop every utterance in a block.
  if (![...decisions.values()].some((d) => d.keep)) {
    const last = utterances[utterances.length - 1];
    decisions.set(last.id, { keep: true, reason: "guard: never drop every utterance in a block", source: "heuristic" });
  }

  return decisions;
};

// ---------------------------------------------------------------------------
// Kept utterances → TakeTrim ranges
// ---------------------------------------------------------------------------

type Range = { fileIdx: number; srcInSec: number; srcOutSec: number; words: Word[] };

/** Turns the kept utterances (in playback order) into padded, merged
 *  ranges — one TakeTrim per surviving contiguous run. Padding is clamped
 *  against each utterance's own immediate neighbor IN ITS FILE (kept or
 *  not), same "never encroach on a neighbor" contract as splitTake.ts's
 *  own padRangesToSegments. Two kept utterances merge into ONE range only
 *  when they're ADJACENT in their file's own utterance list (nothing
 *  dropped between them) and close enough in time (MERGE_GAP_SEC) —
 *  otherwise each surviving run gets its own range/cut, which is the
 *  whole point of this stage. */
const buildRanges = (
  keptInOrder: Utterance[],
  perFileUtterances: Map<number, Utterance[]>,
  fileDurationSec: Map<number, number>,
): Range[] => {
  const ranges: Range[] = [];
  let prevKept: Utterance | null = null;

  for (const u of keptInOrder) {
    const siblings = perFileUtterances.get(u.fileIdx) ?? [];
    const prevSibling = siblings[u.fileUtteranceIndex - 1];
    const nextSibling = siblings[u.fileUtteranceIndex + 1];
    const padIn = prevSibling ? Math.min(PAD_BEFORE_SEC, Math.max(0, (u.srcInSec - prevSibling.srcOutSec) / 2)) : PAD_BEFORE_SEC;
    const padOut = nextSibling ? Math.min(PAD_AFTER_SEC, Math.max(0, (nextSibling.srcInSec - u.srcOutSec) / 2)) : PAD_AFTER_SEC;
    const duration = fileDurationSec.get(u.fileIdx) ?? u.srcOutSec;
    const paddedIn = Math.max(0, u.srcInSec - padIn);
    const paddedOut = Math.min(duration, u.srcOutSec + padOut);

    const contiguousWithPrev =
      prevKept !== null &&
      prevKept.fileIdx === u.fileIdx &&
      u.fileUtteranceIndex === prevKept.fileUtteranceIndex + 1 &&
      u.srcInSec - prevKept.srcOutSec <= MERGE_GAP_SEC;

    if (contiguousWithPrev) {
      const last = ranges[ranges.length - 1];
      last.srcOutSec = paddedOut;
      last.words.push(...u.words);
    } else {
      ranges.push({ fileIdx: u.fileIdx, srcInSec: paddedIn, srcOutSec: paddedOut, words: [...u.words] });
    }
    prevKept = u;
  }
  return ranges;
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const select = async (
  format: Format,
  filled: FilledFormat,
  transcript: Transcript,
  trims: TrimPoints,
  resolverChoice: ResolverChoice = "auto",
): Promise<{ transcript: Transcript; trim: TrimPoints; selection: Selection }> => {
  requireWhisperModel();
  const resolver = pickSelector(resolverChoice);

  const outTranscriptBlocks: BlockTranscript[] = [];
  const outTrimBlocks: BlockTrim[] = [];
  const selectionUtterances: SelectionUtterance[] = [];
  const diagnostics: string[] = [...trims.diagnostics];

  for (const block of format.blocks) {
    const trimEntry = trims.blocks.find((b) => b.blockId === block.id);
    const transcriptEntry = transcript.blocks.find((b) => b.blockId === block.id);

    const passThrough = () => {
      if (trimEntry) outTrimBlocks.push(trimEntry);
      if (transcriptEntry) outTranscriptBlocks.push(transcriptEntry);
    };

    if (block.kind !== "voice" || !trimEntry || !transcriptEntry) {
      passThrough();
      continue;
    }
    // See this file's own doc comment — both out of scope for v1.
    if (block.backgroundReplace || block.plateComposite || block.silhouette) {
      passThrough();
      continue;
    }
    if (trimEntry.takes.some((t) => t.hasUsableVideo === false)) {
      passThrough();
      continue;
    }

    const clip = filled.bindings[block.videoSlot];
    const files = clip?.type === "file" ? [clip] : clip?.type === "files" ? clip.files : undefined;
    if (!files) {
      passThrough();
      continue;
    }

    // Build every take's own utterances, keyed by upload-order fileIdx —
    // doubles as the "full sibling list" buildRanges needs for padding.
    const perFileUtterances = new Map<number, Utterance[]>();
    const fileDurationSec = new Map<number, number>();
    const flatInPlaybackOrder: Utterance[] = [];

    for (let pos = 0; pos < trimEntry.takes.length; pos++) {
      const fileIdx = transcriptEntry.takeOrder[pos] ?? pos;
      const file = files[fileIdx];
      if (!file || file.durationSec === undefined) continue;
      fileDurationSec.set(fileIdx, file.durationSec);
      if (!perFileUtterances.has(fileIdx)) {
        perFileUtterances.set(fileIdx, utterancesForTake(block.id, file, fileIdx, trimEntry.takes[pos]));
      }
      flatInPlaybackOrder.push(...perFileUtterances.get(fileIdx)!);
    }

    if (flatInPlaybackOrder.length === 0) {
      passThrough();
      continue;
    }

    const anchors = literalAnchorsOf(block);
    const instructions = videoSlotInstructions(block);
    const decisions = await decideKeep(flatInPlaybackOrder, instructions, anchors, resolver);

    for (const u of flatInPlaybackOrder) {
      const d = decisions.get(u.id)!;
      selectionUtterances.push({
        id: u.id,
        blockId: block.id,
        fileIdx: u.fileIdx,
        srcInSec: u.srcInSec,
        srcOutSec: u.srcOutSec,
        text: u.words.map((w) => w.text).join(" "),
        keep: d.keep,
        reason: d.reason,
        source: d.source,
      });
      if (!d.keep) {
        diagnostics.push(`select: dropped "${u.words.map((w) => w.text).join(" ")}" from block "${block.id}" (${d.reason})`);
      }
    }

    const kept = flatInPlaybackOrder.filter((u) => decisions.get(u.id)!.keep);
    const ranges = buildRanges(kept, perFileUtterances, fileDurationSec);

    outTrimBlocks.push({
      blockId: block.id,
      takes: ranges.map((r): TakeTrim => ({ srcInSec: r.srcInSec, srcOutSec: r.srcOutSec })),
    });
    outTranscriptBlocks.push({
      blockId: block.id,
      takeOrder: ranges.map((r) => r.fileIdx),
      takes: ranges.map((r) => r.words),
    });
  }

  return {
    transcript: { blocks: outTranscriptBlocks },
    trim: { blocks: outTrimBlocks, diagnostics },
    selection: { utterances: selectionUtterances },
  };
};

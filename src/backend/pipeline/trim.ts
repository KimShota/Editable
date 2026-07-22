import { spawnSync } from "node:child_process";
import { matchLiteralAnchor } from "./literal";
import { pickResolver, ResolverChoice } from "./resolvers";
import { RoleResolver } from "./resolvers/protocol";
import {
  Block,
  BlockTrim,
  BoundFile,
  FilledFormat,
  Format,
  LiteralAnchor,
  TakeTrim,
  Transcript,
  TrimPoints,
  Word,
} from "./types";

/**
 * Module 4 — Trim.
 *
 * Two passes, in order:
 *   1. DEAD AIR — for each take, finds the true speech region(s) from
 *      ffmpeg's silence detection (audio-grounded, not whisper's word
 *      timestamps — whisper's word-level alignment is unreliable right at
 *      a silence boundary, sometimes smearing a leading/trailing pause
 *      into an adjacent word's timestamp by seconds, occasionally past the
 *      clip's own duration). Head and tail dead air is cut regardless of
 *      what whisper thinks the first/last word's time is.
 *   2. FILLER — a leading or trailing chunk of REAL speech, separated from
 *      the rest by a pause long enough to read as structural (not just a
 *      breath), gets judged: is it part of delivering what the slot asked
 *      for, or something said before/after that ("okay cool um", a false
 *      start, an aside)? An LLM judges using the slot's own instructions
 *      as the yardstick, falling back to a filler-word heuristic with no
 *      resolver. Either way, only the ANSWER (keep/drop this chunk) comes
 *      from that judgment — the actual cut always lands on the real,
 *      audio-grounded chunk boundary, never on a whisper timestamp.
 *      Never touches the middle of a take, only its two outer edges.
 *
 * Silent b-roll blocks pass through roughly as filmed (v1 decision), capped
 * at the format's brollDurationSec.
 *
 * A multi-take voice block (see transcribe.ts) gets this treatment PER
 * TAKE — each take's own dead air/filler is trimmed independently — which
 * is what makes concatenating them back-to-back read as one continuous
 * clip with no lingering silence or chatter at the seams.
 *
 * Everything downstream times against the trimmed clip (trim-then-time).
 */

/** Breathing room kept around the speech, seconds. */
const PAD_SEC = 0.15;
const SILENCE_ARGS = "silencedetect=noise=-35dB:d=0.25";
/** Adjacent silence intervals separated by a gap this short are treated as
 *  one continuous dead-air region (a stray click/breath shouldn't split a
 *  silence into pieces too small to snap a boundary against). */
const SILENCE_MERGE_GAP_SEC = 0.15;
/** A pause at least this long, between two speech regions, reads as a
 *  structural break worth judging for filler — short breathing pauses
 *  within one continuous delivery never do. */
const FILLER_GAP_SEC = 0.6;
/** Below this confidence, a filler judgment is discarded (keep everything)
 *  rather than acted on — matches resolveRoles' own threshold. */
const FILLER_CONFIDENCE_THRESHOLD = 0.6;
/** A short, mostly-filler-word chunk is dropped by the no-resolver
 *  heuristic when at least this fraction of its words are in FILLER_WORDS. */
const FILLER_WORD_FRACTION = 0.8;
const FILLER_WORD_MAX_COUNT = 6;
const FILLER_WORDS = new Set([
  "um", "umm", "uh", "uhh", "erm", "hm", "hmm", "huh",
  "okay", "ok", "kay", "cool", "so", "yeah", "yep", "yup",
  "alright", "right", "like", "well", "anyway", "anyways",
]);

type SilenceInterval = { startSec: number; endSec: number };
/** A maximal span of real (non-silent) audio. */
type SpeechRegion = { startSec: number; endSec: number };

/** Every silence interval ffmpeg detects in the clip, in order, adjacent
 *  ones merged together. A silence still open at EOF closes at durationSec. */
export const detectSilenceIntervals = (
  clipAbsPath: string,
  durationSec: number,
): SilenceInterval[] => {
  // silencedetect reports on stderr.
  const out = spawnSync(
    "ffmpeg",
    ["-i", clipAbsPath, "-af", SILENCE_ARGS, "-f", "null", "-"],
    { encoding: "utf8" },
  ).stderr;

  const intervals: SilenceInterval[] = [];
  let openStart: number | null = null;
  for (const line of out.split("\n")) {
    const start = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (start) openStart = Number(start[1]);
    const end = line.match(/silence_end:\s*([\d.]+)/);
    if (end && openStart !== null) {
      intervals.push({ startSec: openStart, endSec: Number(end[1]) });
      openStart = null;
    }
  }
  if (openStart !== null) intervals.push({ startSec: openStart, endSec: durationSec });

  const merged: SilenceInterval[] = [];
  for (const s of intervals) {
    const prev = merged[merged.length - 1];
    if (prev && s.startSec - prev.endSec <= SILENCE_MERGE_GAP_SEC) {
      prev.endSec = Math.max(prev.endSec, s.endSec);
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
};

/** The complement of the silence intervals within [0, durationSec] — every
 *  maximal span of real audio. Audio-grounded, independent of whisper. */
const speechRegions = (silences: SilenceInterval[], durationSec: number): SpeechRegion[] => {
  const regions: SpeechRegion[] = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.startSec > cursor) regions.push({ startSec: cursor, endSec: s.startSec });
    cursor = Math.max(cursor, s.endSec);
  }
  if (cursor < durationSec) regions.push({ startSec: cursor, endSec: durationSec });
  return regions;
};

/** Merge speech regions separated by less than FILLER_GAP_SEC into one
 *  "chunk" — natural mid-delivery breathing pauses shouldn't be treated as
 *  candidate filler boundaries, only genuinely structural ones. */
const speechChunks = (regions: SpeechRegion[]): SpeechRegion[] => {
  const chunks: SpeechRegion[] = [];
  for (const r of regions) {
    const prev = chunks[chunks.length - 1];
    if (prev && r.startSec - prev.endSec < FILLER_GAP_SEC) {
      prev.endSec = r.endSec;
    } else {
      chunks.push({ ...r });
    }
  }
  return chunks;
};

/** Words whose midpoint falls closest to this chunk (nearest-chunk
 *  assignment, not strict containment — a word smeared across a gap by
 *  whisper's alignment still lands on the correct side almost always). */
const wordsInChunk = (words: Word[], chunk: SpeechRegion, allChunks: SpeechRegion[]): Word[] =>
  words.filter((w) => {
    const mid = (w.startSec + w.endSec) / 2;
    let best = allChunks[0];
    let bestDist = Infinity;
    for (const c of allChunks) {
      const dist = mid < c.startSec ? c.startSec - mid : mid > c.endSec ? mid - c.endSec : 0;
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    return best === chunk;
  });

const normalizeWord = (raw: string): string => raw.toLowerCase().replace(/[^a-z']/g, "");

/** No-resolver fallback: a short chunk that's mostly filler words. */
const looksLikeFillerHeuristic = (words: Word[]): boolean => {
  if (words.length === 0 || words.length > FILLER_WORD_MAX_COUNT) return false;
  const fillerCount = words.filter((w) => FILLER_WORDS.has(normalizeWord(w.text))).length;
  return fillerCount / words.length >= FILLER_WORD_FRACTION;
};

/** True if any of the block's literal anchor phrases matches inside this
 *  chunk — such a chunk is never droppable, even if it looks/scores as
 *  filler, since the block's own structure depends on it surviving. */
const chunkHoldsAnAnchor = (chunkWords: Word[], anchors: LiteralAnchor[]): boolean =>
  anchors.some((a) => matchLiteralAnchor(a, chunkWords) !== null);

/** Judges one candidate edge chunk via the LLM resolver: is it part of
 *  delivering what the slot's instructions ask for? Returns null (no
 *  opinion — keep the chunk) if the resolver is unavailable, fails, or
 *  answers below confidence; otherwise true = filler, drop it. */
const judgeChunkWithResolver = async (
  resolver: RoleResolver,
  instructions: string,
  chunkWords: Word[],
  edge: "leading" | "trailing",
  clipDurationSec: number,
): Promise<boolean | null> => {
  if (chunkWords.length === 0) return null;
  try {
    const resolutions = await resolver.resolveBlock({
      blockId: "filler-check",
      anchors: [
        {
          id: "chunk",
          description:
            `This ${edge} chunk of speech, on its own: does it actually help deliver what these ` +
            `filming instructions ask for — "${instructions}" — or is it filler/aside/chatter not part ` +
            `of that (e.g. "okay cool um", a false start, a trailing remark)? Answer by returning this ` +
            `chunk's own full span (start of its first word to end of its last) with confidence near 1 if ` +
            `it DOES help deliver the ask, or confidence near 0 if it's filler/unrelated.`,
          windowStartSec: 0,
          windowEndSec: clipDurationSec,
        },
      ],
      words: chunkWords,
      blockDurationSec: clipDurationSec,
    });
    const hit = resolutions.find((r) => r.roleId === "chunk");
    if (!hit) return null;
    if (hit.confidence >= FILLER_CONFIDENCE_THRESHOLD) return false; // confidently part of the ask
    if (1 - hit.confidence >= FILLER_CONFIDENCE_THRESHOLD) return true; // confidently filler
    return null; // ambiguous — don't act on it
  } catch {
    return null;
  }
};

/** Trims dead air from one take (or a single-clip block, treated as a
 *  one-take block) using audio-grounded speech regions. */
const trimOneTake = (
  file: BoundFile,
  words: Word[],
): { trim: TakeTrim; regions: SpeechRegion[]; clipDurationSec: number } => {
  const clipDuration = file.durationSec;
  if (clipDuration === undefined) {
    throw new Error(`trim: "${file.path}" has no known duration`);
  }
  if (words.length === 0) {
    // Graceful degradation: no detected speech → pass through as filmed.
    return { trim: { srcInSec: 0, srcOutSec: clipDuration }, regions: [], clipDurationSec: clipDuration };
  }

  const silences = detectSilenceIntervals(file.absPath, clipDuration);
  const regions = speechRegions(silences, clipDuration);
  if (regions.length === 0) {
    // ffmpeg found no speech at all (e.g. a very quiet recording) — trust
    // whatever whisper heard rather than emitting an unrenderable clip.
    return { trim: { srcInSec: 0, srcOutSec: clipDuration }, regions: [], clipDurationSec: clipDuration };
  }

  let srcInSec = Math.max(0, regions[0].startSec - PAD_SEC);
  let srcOutSec = Math.min(clipDuration, regions[regions.length - 1].endSec + PAD_SEC);
  if (srcOutSec - srcInSec < 0.1) {
    // Never emit an unrenderably short take; fall back to the full clip.
    srcInSec = 0;
    srcOutSec = clipDuration;
  }
  return { trim: { srcInSec, srcOutSec }, regions, clipDurationSec: clipDuration };
};

/** Narrows a take's base (dead-air-only) trim by dropping a leading and/or
 *  trailing chunk judged to be filler. Only ever moves the two outer
 *  edges inward — the middle of a take is never touched. */
const trimFiller = async (
  base: TakeTrim,
  regions: SpeechRegion[],
  clipDurationSec: number,
  words: Word[],
  anchors: LiteralAnchor[],
  instructions: string,
  resolver: RoleResolver | null,
  label: string,
  diagnostics: string[],
): Promise<TakeTrim> => {
  const chunks = speechChunks(regions);
  if (chunks.length <= 1) return base; // nothing structural to judge

  let srcInSec = base.srcInSec;
  let srcOutSec = base.srcOutSec;

  const tryDropEdge = async (edge: "leading" | "trailing") => {
    if (chunks.length <= 1) return; // never drop down to zero chunks
    const chunk = edge === "leading" ? chunks[0] : chunks[chunks.length - 1];
    const chunkWords = wordsInChunk(words, chunk, chunks);
    if (chunkHoldsAnAnchor(chunkWords, anchors)) return;

    const verdict = resolver
      ? await judgeChunkWithResolver(resolver, instructions, chunkWords, edge, clipDurationSec)
      : looksLikeFillerHeuristic(chunkWords)
        ? true
        : null;
    if (verdict !== true) return;

    const quote = chunkWords.map((w) => w.text).join(" ");
    if (edge === "leading") {
      srcInSec = Math.min(chunks[1].startSec - PAD_SEC, srcOutSec - 0.1);
      srcInSec = Math.max(srcInSec, base.srcInSec);
      chunks.shift();
    } else {
      srcOutSec = Math.max(chunks[chunks.length - 2].endSec + PAD_SEC, srcInSec + 0.1);
      srcOutSec = Math.min(srcOutSec, base.srcOutSec);
      chunks.pop();
    }
    diagnostics.push(`trimmed ${edge} filler "${quote}" from ${label}`);
  };

  // Trailing first: a leading marker phrase is far more likely to be load-
  // bearing (protected by chunkHoldsAnAnchor anyway, but trailing filler —
  // "okay cool um" — is the overwhelmingly common real-world case).
  await tryDropEdge("trailing");
  await tryDropEdge("leading");

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

const literalAnchorsOf = (block: Block): LiteralAnchor[] =>
  [...block.roles, ...block.anchors].filter((a): a is LiteralAnchor => a.kind === "literal");

/** The instructions that describe what a voice block's main clip should
 *  contain — the yardstick filler-judgment measures a chunk against. */
const videoSlotInstructions = (block: Block): string =>
  block.slots.find((s) => s.name === block.videoSlot)?.instructions ?? block.title;

export const trim = async (
  format: Format,
  filled: FilledFormat,
  transcript: Transcript,
  resolverChoice: ResolverChoice = "auto",
): Promise<TrimPoints> => {
  const resolver = pickResolver(resolverChoice);
  const blocks: BlockTrim[] = [];
  const diagnostics: string[] = [];

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
    const anchors = literalAnchorsOf(block);
    const instructions = videoSlotInstructions(block);

    const takes: TakeTrim[] = [];
    for (let pos = 0; pos < takeOrder.length; pos++) {
      const file = files[takeOrder[pos]];
      const words = takeWords[pos] ?? [];
      const { trim: base, regions, clipDurationSec } = trimOneTake(file, words);
      const label =
        takeOrder.length > 1 ? `block "${block.id}" take ${pos + 1}/${takeOrder.length}` : `block "${block.id}"`;
      const narrowed = await trimFiller(
        base,
        regions,
        clipDurationSec,
        words,
        anchors,
        instructions,
        resolver,
        label,
        diagnostics,
      );
      takes.push(narrowed);
    }
    if (block.maxDurationSec !== undefined) applyMaxDuration(takes, block.maxDurationSec);

    blocks.push({ blockId: block.id, takes });
  }

  return { blocks, diagnostics };
};

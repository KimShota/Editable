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
 * Three passes, in order:
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
 *      start, an aside)? A cheap filler-word heuristic always runs and
 *      sets the default verdict; when a resolver is available it can
 *      override that default in EITHER direction, but only when it
 *      answers with real confidence — an ambiguous answer, a schema miss,
 *      or an API error (e.g. no credits) all fall back to the heuristic's
 *      call rather than silently keeping everything, so a down/broken
 *      resolver degrades to "dumber" trimming, never to "no trimming".
 *      Either way, only the ANSWER (keep/drop this chunk) comes from that
 *      judgment — the actual cut always lands on the real, audio-grounded
 *      chunk boundary, never on a whisper timestamp.
 *   3. NON-SPEECH EDGE — a sigh, breath, or throat-clear at a take's very
 *      edge is audible (so pass 1 keeps it — it isn't silence) but is its
 *      own acoustically-isolated speech region, separate from the take's
 *      main content (so pass 1 stops at its boundary, not past it). This
 *      pass compares that edge region's whole-region loudness/noisiness
 *      against the take's main (longest) region and only cuts — past the
 *      edge region AND any dead air beyond it, up to the next real
 *      content — when the profile actually reads as non-speech: much
 *      quieter on its own, or quieter-and-noisier together (a voiced sigh
 *      can have a LOWER zero-crossing rate than speech, so loudness alone
 *      has to be able to decide it). This runs AFTER filler, and
 *      deliberately ignores whisper's words for the cut decision itself —
 *      whisper's alignment is exactly what's unreliable in this spot (see
 *      pass 1), so a word smeared onto this region by mistiming must not
 *      be able to block the cut the way a real filler word correctly can
 *      in pass 2. Any such word is instead re-anchored to the new edge
 *      (see recoverOrphanedEdgeWords) so its caption survives the cut.
 *
 * All three passes only ever move a take's two outer edges inward — the
 * middle of a take is never touched.
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

/** A candidate edge region must be at least this long to judge acoustically
 *  — guards against a near-zero-length region from float rounding, not
 *  against short real events: a region only exists here at all because
 *  ffmpeg's own silencedetect (d=0.25) already found genuine silence on
 *  both sides of it, so even a short one is a real, isolated sound. */
const MIN_NONSPEECH_SEC = 0.08;
/** Above this, an edge region reads as real content (an intro sound,
 *  something happening on camera) rather than a single breath/sigh, which
 *  is brief by nature — leave it alone rather than guess. */
const MAX_NONSPEECH_SEC = 2.5;
/** A candidate region must be at least this many dB quieter than the
 *  take's main region to read as non-speech — a sigh is breathy, not a
 *  shout. Guards the loudness half of the AND judgment below; a merely-
 *  quiet word still fails the noisiness check on its own. */
const NONSPEECH_RMS_MARGIN_DB = 2;
/** A candidate region's zero-crossing rate (proxy for "broadband turbulent
 *  air, no dominant voiced period") must be at least this many times the
 *  main region's own ZCR — a vowel sound has a much lower ZCR than breath
 *  noise. Paired with NONSPEECH_RMS_MARGIN_DB above. */
const NONSPEECH_ZCR_RATIO = 1.3;
/** A candidate region this many dB quieter than the main region reads as
 *  non-speech on loudness ALONE, no ZCR agreement required — a voiced
 *  sigh/breath can have a LOWER zero-crossing rate than speech (it isn't
 *  always broadband-noisy), which would otherwise never clear the AND
 *  check above no matter how obviously quiet it is. */
const NONSPEECH_STRONG_QUIET_MARGIN_DB = 6;
/** Duration given to a word re-anchored by recoverOrphanedEdgeWords — long
 *  enough to render as a real caption word, short enough to stay a sliver
 *  at the very edge of the kept clip. */
const MIN_RECOVERED_WORD_SEC = 0.08;

type SilenceInterval = { startSec: number; endSec: number };
/** A maximal span of real (non-silent) audio. */
type SpeechRegion = { startSec: number; endSec: number };

/** Every silence interval ffmpeg detects in the clip, unmerged, in order.
 *  A silence still open at EOF closes at durationSec. */
const rawSilenceIntervals = (clipAbsPath: string, durationSec: number): SilenceInterval[] => {
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
  return intervals;
};

/** Silence intervals with adjacent ones (gap <= SILENCE_MERGE_GAP_SEC)
 *  merged together — appropriate for speech, where a stray micro-pause
 *  shouldn't split one continuous delivery into separate regions. NOT
 *  appropriate for a short one-shot sound effect, whose entire audible
 *  content can be shorter than the merge gap itself (see audioOnsetSec,
 *  which uses the unmerged intervals directly for exactly this reason). */
export const detectSilenceIntervals = (
  clipAbsPath: string,
  durationSec: number,
): SilenceInterval[] => {
  const intervals = rawSilenceIntervals(clipAbsPath, durationSec);
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

/** First moment of real (non-silent) audio in a file — reused for one-shot
 *  sfx assets, which routinely have a quiet lead-in (a "click" sample that's
 *  mostly a fraction of a second of near-silence before the actual click):
 *  scheduling playback from src time 0 makes the cue sound noticeably late
 *  relative to whatever it's meant to land on. Returns 0 if the file has no
 *  detectable leading silence.
 *
 *  Uses the UNMERGED intervals deliberately: a short sfx's entire audible
 *  content can be briefer than SILENCE_MERGE_GAP_SEC (a ~0.1s click between
 *  two silences would merge into "no speech region at all" under the
 *  speech-tuned merge gap), so onset detection only needs the first raw
 *  interval that actually touches the start of the file. */
export const audioOnsetSec = (absPath: string, durationSec: number): number => {
  const leading = rawSilenceIntervals(absPath, durationSec).find((s) => s.startSec <= 0.02);
  return leading ? Math.min(leading.endSec, durationSec) : 0;
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
 *  delivering what the slot's instructions ask for? `verdict` is null (no
 *  confident opinion) if the resolver is unavailable, fails, or answers
 *  below confidence — callers fall back to the filler-word heuristic in
 *  that case, rather than treating "the resolver had nothing to say" as
 *  "keep the chunk". `detail` is always set, for diagnostics. */
const judgeChunkWithResolver = async (
  resolver: RoleResolver,
  instructions: string,
  chunkWords: Word[],
  edge: "leading" | "trailing",
  clipDurationSec: number,
): Promise<{ verdict: boolean | null; detail: string }> => {
  if (chunkWords.length === 0) return { verdict: null, detail: "resolver: empty chunk" };
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
    if (!hit) return { verdict: null, detail: "resolver: no answer for this chunk" };
    if (hit.confidence >= FILLER_CONFIDENCE_THRESHOLD) {
      return { verdict: false, detail: `resolver: confidently part of the ask (${hit.confidence.toFixed(2)})` };
    }
    if (1 - hit.confidence >= FILLER_CONFIDENCE_THRESHOLD) {
      return { verdict: true, detail: `resolver: confidently filler (${hit.confidence.toFixed(2)})` };
    }
    return { verdict: null, detail: `resolver: ambiguous (confidence ${hit.confidence.toFixed(2)})` };
  } catch (err) {
    return { verdict: null, detail: `resolver error: ${err instanceof Error ? err.message : String(err)}` };
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

/** Raw mono PCM samples for one span of the clip, resampled to 16kHz —
 *  cheap, and plenty of resolution for the energy/zero-crossing checks
 *  below. Returns an empty array if ffmpeg fails for any reason (missing
 *  file, zero-length span) — callers treat that as "can't tell," not "is
 *  non-speech," matching this module's conservative default elsewhere. */
const readPcmMono = (absPath: string, startSec: number, endSec: number): Int16Array => {
  const durationSec = endSec - startSec;
  if (durationSec <= 0) return new Int16Array(0);
  try {
    const out = spawnSync("ffmpeg", [
      "-v", "error",
      "-ss", startSec.toFixed(3),
      "-t", durationSec.toFixed(3),
      "-i", absPath,
      "-ac", "1",
      "-ar", "16000",
      "-f", "s16le",
      "-",
    ]).stdout as Buffer | null;
    if (!out || out.length < 2) return new Int16Array(0);
    return new Int16Array(out.buffer, out.byteOffset, Math.floor(out.length / 2));
  } catch {
    return new Int16Array(0);
  }
};

const rmsDb = (samples: Int16Array): number => {
  if (samples.length === 0) return -Infinity;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
  const rms = Math.sqrt(sumSq / samples.length) / 32768;
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
};

/** Fraction of adjacent sample pairs that cross zero — low for a voiced
 *  vowel (dominated by a low fundamental), high for breathy/turbulent
 *  noise with no dominant low-frequency period. A cheap, pitch-detector-
 *  free stand-in for "is this voiced." */
const zeroCrossingRate = (samples: Int16Array): number => {
  if (samples.length < 2) return 0;
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] >= 0 !== samples[i] >= 0) crossings++;
  }
  return crossings / (samples.length - 1);
};

/** Narrows a take's base (dead-air-only) trim by dropping a leading and/or
 *  trailing chunk judged to be filler. Only ever moves the two outer
 *  edges inward — the middle of a take is never touched.
 *
 *  The filler-word heuristic ALWAYS runs and sets the default verdict for
 *  a chunk; a resolver, when available, can override that default in
 *  EITHER direction but only on a confident answer (see
 *  judgeChunkWithResolver) — an ambiguous answer, a schema miss, or a
 *  thrown error (e.g. no API credits) all leave the heuristic's verdict
 *  standing rather than defaulting to "keep everything". This makes the
 *  heuristic a floor under the resolver, not a fallback for when the
 *  resolver is merely absent. */
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

    const heuristicIsFiller = looksLikeFillerHeuristic(chunkWords);
    let drop = heuristicIsFiller;
    let detail = heuristicIsFiller ? "heuristic: filler-word match" : "heuristic: not filler";

    if (resolver) {
      const judged = await judgeChunkWithResolver(resolver, instructions, chunkWords, edge, clipDurationSec);
      detail = judged.detail;
      if (judged.verdict !== null) drop = judged.verdict; // confident resolver answer wins either way
      // else: resolver had no confident opinion — the heuristic's verdict above stands.
    }

    if (!drop) return;

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
    diagnostics.push(`trimmed ${edge} filler "${quote}" from ${label} (${detail})`);
  };

  // Trailing first: a leading marker phrase is far more likely to be load-
  // bearing (protected by chunkHoldsAnAnchor anyway, but trailing filler —
  // "okay cool um" — is the overwhelmingly common real-world case).
  await tryDropEdge("trailing");
  await tryDropEdge("leading");

  return { srcInSec, srcOutSec };
};

/** Narrows a take's trim (post-filler) by dropping a leading and/or
 *  trailing acoustically-isolated speech region that reads as non-speech
 *  (a sigh, breath, throat-clear) — audible enough to survive the dead-air
 *  pass, but not the take's real content. Ignores whisper's words
 *  entirely for the cut decision: a region only exists here because
 *  ffmpeg's own silence detection already found real silence on both
 *  sides of it, so "is this region non-speech" is answered purely by
 *  comparing its own loudness/noisiness against the take's main (longest)
 *  region. Only ever moves the two outer edges inward, and — like the
 *  filler pass — cuts all the way to the next real content, not just past
 *  the isolated region itself, so the dead air beyond it goes too. */
const trimNonSpeechEdge = (
  base: TakeTrim,
  regions: SpeechRegion[],
  absPath: string,
  label: string,
  diagnostics: string[],
): TakeTrim => {
  if (regions.length < 2) return base; // nothing acoustically isolated from the take's own content

  let srcInSec = base.srcInSec;
  let srcOutSec = base.srcOutSec;

  const mainRegion = regions.reduce((a, b) => (b.endSec - b.startSec > a.endSec - a.startSec ? b : a));
  const mainPcm = readPcmMono(absPath, mainRegion.startSec, mainRegion.endSec);
  const mainDb = rmsDb(mainPcm);
  const mainZcr = zeroCrossingRate(mainPcm);

  const readsAsNonSpeech = (candidate: SpeechRegion): boolean => {
    const span = candidate.endSec - candidate.startSec;
    if (span < MIN_NONSPEECH_SEC || span > MAX_NONSPEECH_SEC) return false;
    const pcm = readPcmMono(absPath, candidate.startSec, candidate.endSec);
    if (pcm.length === 0) return false;

    const db = rmsDb(pcm);
    const quieterThanMain = db <= mainDb - NONSPEECH_RMS_MARGIN_DB;
    if (!quieterThanMain) return false;
    if (mainDb - db >= NONSPEECH_STRONG_QUIET_MARGIN_DB) return true; // quiet enough to decide alone

    const noisierThanMain = mainZcr > 0 && zeroCrossingRate(pcm) >= mainZcr * NONSPEECH_ZCR_RATIO;
    return noisierThanMain;
  };

  const leading = regions[0];
  if (leading !== mainRegion && readsAsNonSpeech(leading)) {
    const next = regions[1];
    srcInSec = Math.min(Math.max(srcInSec, next.startSec - PAD_SEC), srcOutSec - 0.1);
    diagnostics.push(`trimmed leading non-speech audio (sigh/breath) from ${label}`);
  }

  const trailing = regions[regions.length - 1];
  if (trailing !== mainRegion && trailing !== leading && readsAsNonSpeech(trailing)) {
    const prev = regions[regions.length - 2];
    srcOutSec = Math.max(Math.min(srcOutSec, prev.endSec + PAD_SEC), srcInSec + 0.1);
    diagnostics.push(`trimmed trailing non-speech audio (sigh/breath) from ${label}`);
  }

  return { srcInSec, srcOutSec };
};

/** A word the non-speech-edge pass just cut past, despite it carrying real
 *  (if mistimed) text — whisper's own alignment is what's unreliable in
 *  exactly this spot (see this file's header comment), so a word whose
 *  timestamp happens to land in a region that reads acoustically as a
 *  sigh/breath is not evidence the word wasn't really said; it's evidence
 *  whisper mistimed it. Re-anchors each such word to a small, ordered
 *  sliver right at (leading) or right before (trailing) the NEW edge, so
 *  downstream trimming/clamping (timing.ts's toTrimmedWords) doesn't
 *  collapse it to zero duration and silently drop it from captions. Only
 *  called for a non-speech cut — a word dropped by the FILLER pass is
 *  correctly gone; this only rescues words the acoustic pass, which knows
 *  nothing about words, cut on their behalf.
 *
 *  Mutates `words` in place — deliberately: `words` is the same array the
 *  caller's Transcript object holds for this take, so trim()'s caller sees
 *  the correction without a separate return value (see trim()'s own doc
 *  comment on why transcript.json must be re-written after trim runs). */
const recoverOrphanedEdgeWords = (
  words: Word[],
  edge: "leading" | "trailing",
  prevEdgeSec: number,
  newEdgeSec: number,
): void => {
  const orphaned =
    edge === "leading"
      ? words.filter((w) => w.endSec > prevEdgeSec && w.endSec <= newEdgeSec)
      : words.filter((w) => w.startSec < prevEdgeSec && w.startSec >= newEdgeSec);
  if (orphaned.length === 0) return;

  const minSpan = orphaned.length * MIN_RECOVERED_WORD_SEC;
  if (edge === "leading") {
    const firstSurviving = words.find((w) => w.endSec > newEdgeSec && !orphaned.includes(w));
    const ceiling = Math.max(newEdgeSec + minSpan, firstSurviving?.startSec ?? 0);
    const per = (ceiling - newEdgeSec) / orphaned.length;
    orphaned.forEach((w, i) => {
      w.startSec = newEdgeSec + i * per;
      w.endSec = newEdgeSec + (i + 1) * per;
    });
  } else {
    const lastSurviving = [...words].reverse().find((w) => w.startSec < newEdgeSec && !orphaned.includes(w));
    const floor = Math.min(newEdgeSec - minSpan, lastSurviving?.endSec ?? newEdgeSec);
    const per = (newEdgeSec - floor) / orphaned.length;
    orphaned.forEach((w, i) => {
      w.endSec = newEdgeSec - i * per;
      w.startSec = newEdgeSec - (i + 1) * per;
    });
  }
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

/** A broll block's trim is just "as filmed, capped at brollDurationSec" —
 *  no dead-air/filler judgment, since there's no transcript to judge
 *  against. Exported so single-take mode (splitTake.ts's caller) can
 *  compute broll blocks' trim entries the same way without pulling in the
 *  rest of trim() — which assumes every VOICE block's bound clip is its
 *  own standalone file, wrong for a shared take (see splitTake.ts). */
export const trimBrollBlock = (block: Block, filled: FilledFormat): BlockTrim => {
  const clip = filled.bindings[block.videoSlot];
  if (clip?.type !== "file" || clip.durationSec === undefined) {
    throw new Error(`trim: block "${block.id}" has no bound clip with a duration`);
  }
  const target = block.brollDurationSec ?? clip.durationSec;
  return {
    blockId: block.id,
    takes: [{ srcInSec: 0, srcOutSec: Math.min(clip.durationSec, target) }],
  };
};

/** Module 4 entry point. NOTE: mutates word timestamps in place on the
 *  `transcript` passed in (see recoverOrphanedEdgeWords) whenever the
 *  non-speech-edge pass cuts past a whisper-mistimed word — callers that
 *  persist transcript.json must write it out AFTER calling trim(), not
 *  before, or the persisted words won't reflect the correction (see
 *  orchestrate.ts's buildJob, which already writes transcript.json after
 *  trim runs). */
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
      blocks.push(trimBrollBlock(block, filled));
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
      const deFillered = await trimFiller(
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
      const remainingRegions = regions.filter(
        (r) => r.endSec > deFillered.srcInSec && r.startSec < deFillered.srcOutSec,
      );
      const narrowed = trimNonSpeechEdge(deFillered, remainingRegions, file.absPath, label, diagnostics);
      if (narrowed.srcInSec > deFillered.srcInSec) {
        recoverOrphanedEdgeWords(words, "leading", deFillered.srcInSec, narrowed.srcInSec);
      }
      if (narrowed.srcOutSec < deFillered.srcOutSec) {
        recoverOrphanedEdgeWords(words, "trailing", deFillered.srcOutSec, narrowed.srcOutSec);
      }
      takes.push(narrowed);
    }
    if (block.maxDurationSec !== undefined) applyMaxDuration(takes, block.maxDurationSec);

    blocks.push({ blockId: block.id, takes });
  }

  return { blocks, diagnostics };
};

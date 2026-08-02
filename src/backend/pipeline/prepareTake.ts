import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { matchLiteralAnchor } from "./literal";
import { detectSilenceIntervals } from "./trim";
import { requireWhisperModel, transcribeFile } from "./whisper";
import { wordSimilarity } from "./alignToScript";
import { artifactsDir } from "./paths";
import { TakePrepSchema } from "./schemas";
import { BoundFile, Format, LiteralAnchor, TakePrep, TakePrepClip, TakePrepInput, Word } from "./types";

/**
 * Module 2b — Multi-clip speaking take.
 *
 * A speakingTakeSlot binding can be several separate clips instead of one
 * continuous recording — e.g. one clip saying "Writing emails?" and another
 * saying "Claude", filmed apart. ensureTakePrep turns that {files:[...]}
 * binding into ONE derived, edge-trimmed, script-ordered MP4
 * (jobs/<id>/derived/<slot>-combined.mp4), so intake.ts can bind the take
 * slot as an ordinary single {type:"file"} asset — everything downstream
 * (takeIsBound/isTakeCovered, the voice-block clone, matte/backgroundReplace's
 * sharedTake, splitTake) keeps seeing exactly what it always has, one shared
 * take file, and needs no changes.
 *
 * Per clip: whisper for word timestamps, then a "fitting" (semi-global)
 * word-alignment against the job's own script (free to start/end anywhere
 * in it — a clip is a FRAGMENT of the whole take, not the whole thing) to
 * find where it belongs; a clip with no confident match falls back to
 * upload order (the same honest default literal.ts's orderTakes already
 * uses for multi-take voice blocks). Confidently-placed clips that turn out
 * to cover the same script region (a re-recorded retake) are deduped, kept
 * clips get their own leading/trailing dead air trimmed, and the survivors
 * are concatenated back-to-back via ffmpeg. Result is cached in
 * artifacts/<job>/takePrep.json, keyed on each input file's own path/size/
 * mtime, so re-running intake() (which happens on nearly every request) is
 * a stat, not a re-transcribe-and-re-encode.
 */

const PIPELINE_VERSION = "1";

/** Breathing room kept around each clip's own detected speech, seconds —
 *  same constant/rationale as splitTake.ts's and trim.ts's own PAD_SEC. */
const PAD_SEC = 0.15;

/** Needleman-Wunsch gap cost — identical to alignToScript.ts's own, so a
 *  clip's fit against the script scores on the same scale. */
const GAP_PENALTY = -0.4;
/** A matched pair below this similarity isn't a real match — same floor
 *  alignToScript.ts uses for transcript correction. */
const SIMILARITY_FLOOR = 0.5;
/** A clip's overall fit (mean similarity over ALL its own words, matched or
 *  not) must clear this to be placed with confidence. */
const MIN_ALIGN_SCORE = 0.55;
/** A single matched word only counts as a confident placement (the "one
 *  clip says just 'Claude'" case) when it's this close a match AND unique
 *  in the script — otherwise a short filler word matching every line's
 *  "the"/"a" would misplace the clip. */
const UNIQUE_WORD_SIMILARITY = 0.8;
/** Two confidently-placed clips whose script ranges overlap by more than
 *  this fraction of the shorter range are treated as the same line
 *  re-recorded, not two different lines — the loser is excluded. */
const RETAKE_OVERLAP_FRACTION = 0.5;
/** Within this fraction of each other's matched-range length, an overlap's
 *  "winner" is decided by upload order (later = the user's own fix)
 *  instead of range size. */
const RETAKE_TIE_FRACTION = 0.2;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const takePrepPath = (jobId: string): string => path.join(artifactsDir(jobId), "takePrep.json");

/** The persisted multi-clip prep, or null before it's ever been computed
 *  for this job (or the file failed to parse) — exported for the split
 *  route/orchestrate.ts's runSplit, which reuse its merged words instead of
 *  re-transcribing the combined file. */
export const readTakePrep = (jobId: string): TakePrep | null => {
  const file = takePrepPath(jobId);
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const parsed = TakePrepSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

const writeTakePrep = (jobId: string, prep: TakePrep): void => {
  const dir = artifactsDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(takePrepPath(jobId), JSON.stringify(prep, null, 2));
};

const statSignature = (file: BoundFile): TakePrepInput => {
  const stat = fs.statSync(file.absPath);
  return { path: file.path, sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
};

const sameInput = (a: TakePrepInput, b: TakePrepInput): boolean =>
  a.path === b.path && a.sizeBytes === b.sizeBytes && a.mtimeMs === b.mtimeMs;

/** Order-independent: the COMBINED file's own clip order can differ from
 *  upload order, so freshness only asks "is this the same set of input
 *  files, unchanged" — not "in the same positions". */
const isFresh = (cached: TakePrep, inputs: TakePrepInput[], absCombinedPath: string): boolean =>
  cached.pipelineVersion === PIPELINE_VERSION &&
  fs.existsSync(absCombinedPath) &&
  cached.clips.length === inputs.length &&
  inputs.every((input) => cached.clips.some((c) => sameInput(c.input, input)));

// ---------------------------------------------------------------------------
// Per-clip transcription (reusing cached words for an unchanged clip)
// ---------------------------------------------------------------------------

type ClipTranscript = {
  file: BoundFile;
  uploadIdx: number;
  input: TakePrepInput;
  words: Word[];
};

const transcribeClips = (files: BoundFile[], inputs: TakePrepInput[], cached: TakePrep | null): ClipTranscript[] => {
  requireWhisperModel();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-preparetake-"));
  try {
    return files.map((file, uploadIdx) => {
      const cachedClip = cached?.clips.find((c) => sameInput(c.input, inputs[uploadIdx]));
      const words = cachedClip ? cachedClip.words : transcribeFile(file.absPath, workDir);
      return { file, uploadIdx, input: inputs[uploadIdx], words };
    });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// Ordering — script-fitting alignment (or, with no script, literal-anchor
// matching — the same two-tier strategy splitTake.ts/orderTakes already use
// elsewhere in this pipeline).
// ---------------------------------------------------------------------------

const scriptWordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, "")
    .split(/\s+/)
    .filter(Boolean);

/** Concatenates every non-optional voice block's own script.json line, in
 *  format order — the reference a clip's own words are fit against. */
const buildScriptWords = (format: Format, scriptByBlockId: Map<string, string>): string[] => {
  const words: string[] = [];
  for (const block of format.blocks) {
    if (block.kind !== "voice" || block.optional) continue;
    const text = scriptByBlockId.get(block.id);
    if (text) words.push(...scriptWordsOf(text));
  }
  return words;
};

type AlignedPair = { clipIndex: number; scriptIndex: number };
type FitResult = { pairs: AlignedPair[]; scriptStartIdx: number; scriptEndIdx: number; score: number };

/**
 * Semi-global ("fitting") word alignment: a clip is a FRAGMENT that may
 * start and end anywhere inside the (much longer) script, so — unlike
 * alignToScript.ts's global alignment, which assumes the two sequences
 * cover the same content start-to-end — both the leading and trailing
 * script-side gap are free (cost 0), while a clip-side gap (an ad-lib the
 * script doesn't have) still costs GAP_PENALTY. Returns null when nothing
 * scores above the similarity floor at all.
 */
const fitAlign = (clipWords: string[], scriptWords: string[]): FitResult | null => {
  const n = clipWords.length;
  const m = scriptWords.length;
  if (n === 0 || m === 0) return null;

  const score: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) score[i][0] = score[i - 1][0] + GAP_PENALTY;
  // score[0][j] stays 0 for every j: free script-side prefix — a clip
  // fragment starting mid-script isn't penalized for "skipping" the lines
  // before it, the way a normal global alignment would.
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const matchScore = score[i - 1][j - 1] + wordSimilarity(clipWords[i - 1], scriptWords[j - 1]);
      const skipClip = score[i - 1][j] + GAP_PENALTY;
      const skipScript = score[i][j - 1] + GAP_PENALTY;
      score[i][j] = Math.max(matchScore, skipClip, skipScript);
    }
  }

  // Free script-side suffix too: best over the whole final row, not forced
  // to reach column m.
  let bestJ = 0;
  for (let j = 1; j <= m; j++) {
    if (score[n][j] > score[n][bestJ]) bestJ = j;
  }

  const pairs: AlignedPair[] = [];
  let i = n;
  let j = bestJ;
  while (i > 0) {
    const matchScore = j > 0 ? score[i - 1][j - 1] + wordSimilarity(clipWords[i - 1], scriptWords[j - 1]) : -Infinity;
    if (j > 0 && score[i][j] === matchScore) {
      pairs.push({ clipIndex: i - 1, scriptIndex: j - 1 });
      i--;
      j--;
    } else if (j > 0 && score[i][j] === score[i][j - 1] + GAP_PENALTY) {
      j--;
    } else {
      i--;
    }
  }
  pairs.reverse();

  const matched = pairs.filter((p) => wordSimilarity(clipWords[p.clipIndex], scriptWords[p.scriptIndex]) >= SIMILARITY_FLOOR);
  if (matched.length === 0) return null;

  const scriptIndices = matched.map((p) => p.scriptIndex);
  const totalSimilarity = matched.reduce((sum, p) => sum + wordSimilarity(clipWords[p.clipIndex], scriptWords[p.scriptIndex]), 0);
  return {
    pairs: matched,
    scriptStartIdx: Math.min(...scriptIndices),
    scriptEndIdx: Math.max(...scriptIndices),
    // Normalized over ALL of the clip's own words (not just the matched
    // ones) — a clip that's mostly ad-lib around one matched word scores
    // low even though that one word matched perfectly.
    score: totalSimilarity / n,
  };
};

const isUniqueInScript = (scriptWord: string, scriptWords: string[]): boolean =>
  scriptWords.filter((w) => wordSimilarity(w, scriptWord) >= UNIQUE_WORD_SIMILARITY).length === 1;

/** True when the matched span's own word sequence recurs elsewhere in the
 *  script (e.g. a common phrase repeated across two lines) — such a match
 *  is too ambiguous to place confidently, even if its own fit score is high. */
const spanRecursElsewhere = (scriptWords: string[], scriptStartIdx: number, scriptEndIdx: number): boolean => {
  const span = scriptWords.slice(scriptStartIdx, scriptEndIdx + 1);
  if (span.length === 0) return false;
  let occurrences = 0;
  for (let start = 0; start + span.length <= scriptWords.length; start++) {
    let total = 0;
    for (let k = 0; k < span.length; k++) total += wordSimilarity(scriptWords[start + k], span[k]);
    if (total / span.length >= UNIQUE_WORD_SIMILARITY) occurrences++;
  }
  return occurrences > 1;
};

type ClipPlacement = ClipTranscript & {
  scriptStartIdx: number | null;
  scriptEndIdx: number | null;
  score: number;
  confident: boolean;
  /** Ascending value the final ordering sorts by once confident; -1 (i.e.
   *  "sorts first") for an unconfident clip until orderPlacements inherits
   *  it from the nearest preceding confident clip in upload order. */
  sortKey: number;
};

const alignAgainstScript = (clip: ClipTranscript, scriptWords: string[]): ClipPlacement => {
  const clipWordTexts = clip.words.map((w) => w.text);
  const fit = fitAlign(clipWordTexts, scriptWords);
  if (!fit) return { ...clip, scriptStartIdx: null, scriptEndIdx: null, score: 0, confident: false, sortKey: -1 };

  const singleUniqueFragment =
    fit.pairs.length === 1 &&
    wordSimilarity(clipWordTexts[fit.pairs[0].clipIndex], scriptWords[fit.pairs[0].scriptIndex]) >= UNIQUE_WORD_SIMILARITY &&
    isUniqueInScript(scriptWords[fit.pairs[0].scriptIndex], scriptWords);
  let confident = fit.score >= MIN_ALIGN_SCORE && (fit.pairs.length >= 2 || singleUniqueFragment);
  if (confident && spanRecursElsewhere(scriptWords, fit.scriptStartIdx, fit.scriptEndIdx)) confident = false;

  return {
    ...clip,
    scriptStartIdx: fit.scriptStartIdx,
    scriptEndIdx: fit.scriptEndIdx,
    score: fit.score,
    confident,
    sortKey: confident ? fit.scriptStartIdx : -1,
  };
};

/** No script.json to fit against — falls back to the same "first literal
 *  anchor marks the block" convention splitTake.ts's own walk and
 *  literal.ts's orderTakes already rely on. */
const alignAgainstAnchors = (clip: ClipTranscript, format: Format): ClipPlacement => {
  const walkBlocks = format.blocks.filter((b) => b.kind === "voice" && !b.optional);
  let bestBlockIdx = -1;
  let bestConfidence = 0;
  walkBlocks.forEach((block, idx) => {
    const marker = [...block.roles, ...block.anchors].find((a): a is LiteralAnchor => a.kind === "literal");
    if (!marker) return;
    const match = matchLiteralAnchor(marker, clip.words);
    if (match && match.confidence > bestConfidence) {
      bestConfidence = match.confidence;
      bestBlockIdx = idx;
    }
  });
  const confident = bestBlockIdx !== -1;
  return { ...clip, scriptStartIdx: null, scriptEndIdx: null, score: bestConfidence, confident, sortKey: confident ? bestBlockIdx : -1 };
};

// ---------------------------------------------------------------------------
// Retake dedupe
// ---------------------------------------------------------------------------

type Ordering = "aligned" | "uploadOrder" | "excluded";
type ResolvedPlacement = ClipPlacement & { ordering: Ordering };

const rangeOf = (p: ClipPlacement): [number, number] | null => {
  if (p.scriptStartIdx !== null && p.scriptEndIdx !== null) return [p.scriptStartIdx, p.scriptEndIdx];
  return p.confident ? [p.sortKey, p.sortKey] : null;
};

const overlapFraction = (a: [number, number], b: [number, number]): number => {
  const overlap = Math.min(a[1], b[1]) - Math.max(a[0], b[0]) + 1;
  if (overlap <= 0) return 0;
  const shorter = Math.min(a[1] - a[0] + 1, b[1] - b[0] + 1);
  return overlap / shorter;
};

/** Two confidently-placed clips covering (mostly) the same script region
 *  are a retake, not two different lines — keeps the larger match (ties
 *  broken toward the later upload, the user's own presumed fix), excludes
 *  the other from the combined cut entirely. */
const dedupeRetakes = (placements: ClipPlacement[]): { resolved: ResolvedPlacement[]; diagnostics: string[] } => {
  const excluded = new Set<number>();
  const diagnostics: string[] = [];
  const confident = placements.filter((p) => p.confident && rangeOf(p) !== null);

  for (let a = 0; a < confident.length; a++) {
    for (let b = a + 1; b < confident.length; b++) {
      const pa = confident[a];
      const pb = confident[b];
      if (excluded.has(pa.uploadIdx) || excluded.has(pb.uploadIdx)) continue;
      const ra = rangeOf(pa)!;
      const rb = rangeOf(pb)!;
      if (overlapFraction(ra, rb) <= RETAKE_OVERLAP_FRACTION) continue;

      const lenA = ra[1] - ra[0] + 1;
      const lenB = rb[1] - rb[0] + 1;
      const tooCloseToCallBySize = Math.abs(lenA - lenB) / Math.max(lenA, lenB) <= RETAKE_TIE_FRACTION;
      const loser = tooCloseToCallBySize ? (pa.uploadIdx < pb.uploadIdx ? pa : pb) : lenA >= lenB ? pb : pa;
      excluded.add(loser.uploadIdx);
      diagnostics.push(
        `clip "${loser.file.path}" looks like a retake of the same line(s) as another clip — excluded from the combined take (delete the unwanted clip to include it instead)`,
      );
    }
  }

  const resolved: ResolvedPlacement[] = placements.map((p) => ({
    ...p,
    ordering: excluded.has(p.uploadIdx) ? "excluded" : p.confident ? "aligned" : "uploadOrder",
  }));
  return { resolved, diagnostics };
};

/** Kept clips sorted by their placement; an unconfident clip inherits the
 *  sort key of the nearest PRECEDING confident clip in upload order (or -1,
 *  i.e. "goes first," if none precede it) — so it lands right after
 *  whichever line it was probably filmed alongside instead of drifting to
 *  an arbitrary position. All-unconfident degrades to pure upload order,
 *  the same honest default literal.ts's orderTakes uses. Excluded clips are
 *  appended last (see TakePrepSchema's own doc comment). */
const orderPlacements = (placements: ResolvedPlacement[]): ResolvedPlacement[] => {
  const kept = placements.filter((p) => p.ordering !== "excluded");
  let lastConfidentSortKey = -1;
  const withInheritedKeys = kept.map((p) => {
    if (p.ordering === "aligned") {
      lastConfidentSortKey = p.sortKey;
      return p;
    }
    return { ...p, sortKey: lastConfidentSortKey };
  });
  const sortedKept = [...withInheritedKeys].sort((a, b) => a.sortKey - b.sortKey || a.uploadIdx - b.uploadIdx);
  const excludedClips = placements.filter((p) => p.ordering === "excluded").sort((a, b) => a.uploadIdx - b.uploadIdx);
  return [...sortedKept, ...excludedClips];
};

// ---------------------------------------------------------------------------
// Edge trim (per kept clip) + concat
// ---------------------------------------------------------------------------

type SpeechRegion = { startSec: number; endSec: number };

/** Complement of the merged silence intervals — same shape as trim.ts's own
 *  private speechRegions/splitTake.ts's own speechRegions, reimplemented
 *  locally per those modules' own precedent (each caller's use is distinct
 *  enough — whole shared take vs one standalone clip vs, here, several
 *  independent clips — that sharing one export isn't worth the coupling). */
const speechRegionsOf = (silences: { startSec: number; endSec: number }[], durationSec: number): SpeechRegion[] => {
  const regions: SpeechRegion[] = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.startSec > cursor) regions.push({ startSec: cursor, endSec: s.startSec });
    cursor = Math.max(cursor, s.endSec);
  }
  if (cursor < durationSec) regions.push({ startSec: cursor, endSec: durationSec });
  return regions;
};

type TrimmedPlacement = ResolvedPlacement & { srcInSec: number; srcOutSec: number };

/** Audio-grounded leading/trailing dead-air trim for one kept clip — same
 *  method and PAD_SEC as trim.ts's own trimOneTake/splitTake.ts's whole-take
 *  edges, applied per clip here since each is its own standalone file. */
const edgeTrim = (p: ResolvedPlacement): TrimmedPlacement => {
  const duration = p.file.durationSec;
  if (duration === undefined) throw new Error(`prepareTake: "${p.file.path}" has no known duration`);
  const silences = detectSilenceIntervals(p.file.absPath, duration);
  const regions = speechRegionsOf(silences, duration);
  if (regions.length === 0) return { ...p, srcInSec: 0, srcOutSec: duration };

  let srcInSec = Math.max(0, regions[0].startSec - PAD_SEC);
  let srcOutSec = Math.min(duration, regions[regions.length - 1].endSec + PAD_SEC);
  if (srcOutSec - srcInSec < 0.1) {
    srcInSec = 0;
    srcOutSec = duration;
  }
  return { ...p, srcInSec, srcOutSec };
};

type PositionedClip = TrimmedPlacement & { offsetSec: number };

/**
 * Normalizes every kept clip to the FIRST kept clip's own resolution
 * (same-device filming makes this a no-op almost always) and a shared frame
 * rate, then concatenates via the concat FILTER (not the demuxer — clips
 * may differ in codec/container even when same-device, and the demuxer
 * requires identical streams) with per-clip trim/atrim doing the actual cut,
 * frame-accurate unlike a stream-copy concat would be at a non-keyframe cut
 * point.
 */
const buildCombinedFile = (clips: PositionedClip[], targetFps: number, absCombinedPath: string): void => {
  const targetWidth = clips[0].file.width;
  const targetHeight = clips[0].file.height;
  if (!targetWidth || !targetHeight) {
    throw new Error(`prepareTake: "${clips[0].file.path}" has no known video dimensions`);
  }

  fs.mkdirSync(path.dirname(absCombinedPath), { recursive: true });

  const inputs = clips.flatMap((c) => ["-i", c.file.absPath]);
  const filterParts: string[] = [];
  const labelPairs: string[] = [];
  clips.forEach((c, idx) => {
    const v = `v${idx}`;
    const a = `a${idx}`;
    filterParts.push(
      `[${idx}:v]trim=start=${c.srcInSec.toFixed(3)}:end=${c.srcOutSec.toFixed(3)},setpts=PTS-STARTPTS,` +
        `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},` +
        `fps=${targetFps},setsar=1,format=yuv420p[${v}]`,
    );
    filterParts.push(
      `[${idx}:a]atrim=start=${c.srcInSec.toFixed(3)}:end=${c.srcOutSec.toFixed(3)},asetpts=PTS-STARTPTS,` +
        `aresample=48000:async=1,aformat=sample_rates=48000:channel_layouts=stereo[${a}]`,
    );
    labelPairs.push(`[${v}][${a}]`);
  });
  filterParts.push(`${labelPairs.join("")}concat=n=${clips.length}:v=1:a=1[v][a]`);

  execFileSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      ...inputs,
      "-filter_complex", filterParts.join(";"),
      "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-c:a", "aac", "-b:a", "192k",
      absCombinedPath,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
};

/** Every kept clip's words, shifted from clip-relative into the combined
 *  file's own timeline — words outside the clip's own trim window are
 *  dropped (they no longer exist in the cut). */
const mergeWords = (clips: PositionedClip[]): Word[] => {
  const merged: Word[] = [];
  for (const c of clips) {
    for (const w of c.words) {
      if (w.startSec < c.srcInSec || w.startSec >= c.srcOutSec) continue;
      merged.push({
        text: w.text,
        startSec: w.startSec - c.srcInSec + c.offsetSec,
        endSec: Math.min(w.endSec, c.srcOutSec) - c.srcInSec + c.offsetSec,
      });
    }
  }
  return merged;
};

const toClipRecord = (c: PositionedClip): TakePrepClip => ({
  input: c.input,
  words: c.words,
  srcInSec: c.srcInSec,
  srcOutSec: c.srcOutSec,
  offsetSec: c.offsetSec,
  scriptStartIdx: c.scriptStartIdx,
  scriptEndIdx: c.scriptEndIdx,
  score: c.score,
  ordering: c.ordering,
});

const toExcludedClipRecord = (p: ResolvedPlacement): TakePrepClip => ({
  input: p.input,
  words: p.words,
  srcInSec: 0,
  srcOutSec: 0,
  offsetSec: 0,
  scriptStartIdx: p.scriptStartIdx,
  scriptEndIdx: p.scriptEndIdx,
  score: p.score,
  ordering: "excluded",
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Turns a multi-clip speaking-take binding into one combined, cached MP4 —
 * called from intake.ts whenever the speakingTakeSlot binding is
 * `{type:"files"}` with more than one clip (a single clip is short-
 * circuited by intake.ts itself before this is ever called). Cheap on a
 * cache hit (a stat per input file + confirming the combined MP4 still
 * exists on disk) — no whisper, no ffmpeg — since intake() runs on nearly
 * every request (build, reassemble, the split UI, a CLI --only invocation).
 */
export const ensureTakePrep = (
  jobDir: string,
  jobId: string,
  slotName: string,
  files: BoundFile[],
  format: Format,
  scriptByBlockId: Map<string, string> | undefined,
): TakePrep => {
  const combinedPath = path.posix.join("derived", `${slotName}-combined.mp4`);
  const absCombinedPath = path.join(jobDir, combinedPath);
  const inputs = files.map(statSignature);

  const cached = readTakePrep(jobId);
  if (cached && isFresh(cached, inputs, absCombinedPath)) return cached;

  const clips = transcribeClips(files, inputs, cached);

  const scriptWords = scriptByBlockId ? buildScriptWords(format, scriptByBlockId) : [];
  const placements =
    scriptWords.length > 0
      ? clips.map((c) => alignAgainstScript(c, scriptWords))
      : clips.map((c) => alignAgainstAnchors(c, format));

  const { resolved, diagnostics } = dedupeRetakes(placements);
  const ordered = orderPlacements(resolved);

  const kept = ordered.filter((p) => p.ordering !== "excluded").map(edgeTrim);
  let offset = 0;
  const positioned: PositionedClip[] = kept.map((c) => {
    const offsetSec = offset;
    offset += c.srcOutSec - c.srcInSec;
    return { ...c, offsetSec };
  });

  buildCombinedFile(positioned, format.fps, absCombinedPath);

  const unconfidentDiagnostics = positioned
    .filter((c) => c.ordering === "uploadOrder")
    .map((c) => `clip "${c.file.path}" wasn't confidently matched to your script — placed by upload order`);

  const prep: TakePrep = {
    slotName,
    clips: [
      ...positioned.map(toClipRecord),
      ...ordered.filter((p) => p.ordering === "excluded").map(toExcludedClipRecord),
    ],
    combinedPath,
    combinedDurationSec: offset,
    words: mergeWords(positioned),
    diagnostics: [...diagnostics, ...unconfidentDiagnostics],
    pipelineVersion: PIPELINE_VERSION,
  };

  // A new combined file makes any existing split stale — the spans it
  // recorded are offsets into the OLD combined timeline.
  const splitTakeFile = path.join(artifactsDir(jobId), "splitTake.json");
  fs.rmSync(splitTakeFile, { force: true });

  writeTakePrep(jobId, prep);
  return prep;
};

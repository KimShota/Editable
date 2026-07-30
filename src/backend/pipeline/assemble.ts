import fs from "node:fs";
import path from "node:path";
import {
  BoundAsset,
  ComponentRef,
  Edl,
  EdlCaptionGroup,
  EdlOverlay,
  EdlSfx,
  EdlTransition,
  EdlVideoSegment,
  FilledFormat,
  Format,
  FormatEvent,
  ResolvedRoles,
  Transcript,
  TrimPoints,
  Word,
} from "./types";
import { EdlSchema } from "./schemas";
import { anchoredTimeSec, clamp, concatenateTakes } from "./timing";
import { audioOnsetSec } from "./trim";
import { publicJobPrefix, formatStylesDir, formatAssetsDir } from "./paths";
import { loadStyleProfile } from "./generation/styleProfile";
import { loadPlatesManifest } from "./generation/plates";

/**
 * Module 6 — Timeline assembly.
 * Combines everything into the master timeline (EDL): trimmed clips in
 * block order, overlays at their resolved timestamps, sound effects,
 * captions from the transcript, transitions from the format, and per-video
 * user overrides applied on top. The EDL is a complete, self-contained JSON
 * description of the finished video — every element at an absolute time —
 * and is inspectable before any rendering happens.
 */

/** Break captions into a new group after a speech gap this long. */
const CAPTION_GAP_SEC = 0.6;
const CAPTION_WORDS_PER_GROUP = 3;
/** How long the last caption group of a run lingers after its final word. */
const CAPTION_TAIL_SEC = 0.15;
/** No word (however whisper timed it) contributes less than this to its
 *  caption group's own span — a genuinely zero/near-zero-duration word
 *  timestamp (whisper occasionally emits one) would otherwise seed a
 *  flash-frame group that the "extend to next" pass can't always rescue
 *  (a block's LAST group has no next group to extend into). */
const MIN_WORD_DURATION_SEC = 0.08;
/** A caption group still shorter than this after grouping/extension gets
 *  merged into its neighbor rather than rendered — a bug here once
 *  shipped a zero-duration group that Captions.tsx's half-open
 *  `tSec >= tlIn && tSec < tlOut` check could never match, silently
 *  dropping that word from the screen entirely. */
const MIN_GROUP_DURATION_SEC = 0.15;
/** A bigTitle keyword card holds for at least this long regardless of how
 *  briefly the word itself was spoken — it's a punctuation beat, not a
 *  running transcript; the reference's own title cards visibly outlast
 *  the word (~1.8 words/sec).*/
const MIN_BIGTITLE_DURATION_SEC = 0.45;
const DEFAULT_TRANSITION_SEC = 0.3;
/** Two sfx cues within this long of each other, from the same source file,
 *  are the same beat firing twice (e.g. a "sequence" whose runway collapsed
 *  before this fix) rather than two intentionally distinct sounds. */
const SFX_DEDUPE_EPS_SEC = 0.05;

/** Common function words a keyword-title pick should never land on, even
 *  if they happen to be the longest word in a short candidate list. */
const KEYWORD_STOPWORDS = new Set([
  "a", "an", "the", "is", "am", "are", "i", "i'm", "im", "and", "to", "of",
  "in", "on", "for", "by", "my", "your", "this", "that", "it", "it's", "its",
  "be", "gonna", "going", "so", "as", "at", "with",
]);

const normalizeKeyword = (w: string): string => w.toLowerCase().replace(/[^a-z0-9']/g, "");

/** Picks up to `maxWords` "most substantial" words from `candidates`
 *  (longest non-stopword first), then re-sorts the pick back into speech
 *  order — see BlockSchema's keywordTitle doc comment for why this is a
 *  heuristic rather than a real model call. */
const pickKeywordWords = (candidates: Word[], maxWords: number): Word[] => {
  const scored = candidates
    .map((w, i) => ({ w, i, norm: normalizeKeyword(w.text) }))
    .filter((c) => c.norm.length > 2 && !KEYWORD_STOPWORDS.has(c.norm));
  scored.sort((a, b) => b.norm.length - a.norm.length || a.i - b.i);
  const picked = scored.slice(0, maxWords);
  picked.sort((a, b) => a.i - b.i);
  return picked.map((c) => c.w);
};

type FileAsset = Extract<BoundAsset, { type: "file" }>;

const fileAsset = (filled: FilledFormat, slotName: string): FileAsset | undefined => {
  const asset = filled.bindings[slotName];
  return asset?.type === "file" ? asset : undefined;
};

const brollFile = (filled: FilledFormat, block: { id: string; videoSlot: string }): FileAsset[] => {
  const asset = fileAsset(filled, block.videoSlot);
  if (!asset) throw new Error(`assemble: block "${block.id}" has no bound clip`);
  return [asset];
};

/** A voice block's main clip as an ordered list of takes to concatenate —
 *  one entry for an ordinary single-clip block, several for one filmed as
 *  separate takes (the marker line and the explanation shot apart). */
const videoTakeFiles = (
  filled: FilledFormat,
  slotName: string,
): Array<{ path: string; absPath: string; durationSec?: number }> => {
  const asset = filled.bindings[slotName];
  if (asset?.type === "file") return [asset];
  if (asset?.type === "files") return asset.files;
  throw new Error(`assemble: slot "${slotName}" has no bound clip`);
};

const textAsset = (filled: FilledFormat, slotName: string): string | undefined => {
  const asset = filled.bindings[slotName];
  return asset?.type === "text" ? asset.text : undefined;
};

export const assemble = (
  format: Format,
  filled: FilledFormat,
  transcript: Transcript,
  trims: TrimPoints,
  resolved: ResolvedRoles,
): Edl => {
  const overrides = filled.overrides;
  const jobPrefix = publicJobPrefix(filled.jobId);
  const assets: Record<string, string> = {};

  /** Register a file for staging; returns its public/-relative src. */
  const stage = (asset: { path: string; absPath: string }): string => {
    const src = path.posix.join(jobPrefix, ...asset.path.split(path.sep));
    assets[src] = asset.absPath;
    return src;
  };

  /** Same idea as `stage`, for a format's own checked-in template asset
   *  (formats/assets/<formatId>/, e.g. the default music bed) — namespaced
   *  under the format id rather than a job id, since it's the SAME file
   *  shared by every job of this format, not something copied per-job. */
  const stageTemplateAsset = (absPath: string, fileName: string): string => {
    const src = path.posix.join("formats", format.id, fileName);
    assets[src] = absPath;
    return src;
  };

  type ResolvedComponent = {
    component: string;
    params: Record<string, unknown>;
    audioDurationSec?: number;
    audioOnsetSec?: number;
    /** The bound image/video's own pixel size, when known — lets the
     *  overlay's default on-canvas box (see defaultOverlayBox below) fit
     *  the actual picture instead of defaulting to the full frame. */
    mediaWidth?: number;
    mediaHeight?: number;
  };

  /** Max box size (fraction of the frame) each media overlay type used to
   *  hard-code internally via CSS — now expressed as the box itself, so
   *  the box IS the visible content instead of a full-frame wrapper the
   *  component quietly shrinks inside of. */
  const DEFAULT_MEDIA_BOX_MAX: Record<string, { maxWidthFrac: number; maxHeightFrac: number }> = {
    ImageOverlay: { maxWidthFrac: 0.7, maxHeightFrac: 0.6 },
    VideoOverlay: { maxWidthFrac: 0.88, maxHeightFrac: 0.62 },
  };

  /** A centered box, as large as it can be within the component's usual
   *  max size, without exceeding the media's own aspect ratio — computed
   *  in PIXEL space since x/y/width/height fractions are of DIFFERENT
   *  absolute scales (format.width vs. format.height). */
  const defaultOverlayBox = (
    component: string,
    params: Record<string, unknown>,
    mediaWidth: number | undefined,
    mediaHeight: number | undefined,
  ): { x: number; y: number; width: number; height: number } => {
    const bounds = DEFAULT_MEDIA_BOX_MAX[component];
    if (!bounds || !mediaWidth || !mediaHeight) {
      return { x: 0, y: 0, width: 1, height: 1 };
    }
    const widthPctParam = typeof params.widthPct === "number" ? params.widthPct / 100 : undefined;
    const maxWidthPx = (widthPctParam ?? bounds.maxWidthFrac) * format.width;
    const maxHeightPx = bounds.maxHeightFrac * format.height;
    const aspect = mediaWidth / mediaHeight;
    let widthPx = maxWidthPx;
    let heightPx = maxWidthPx / aspect;
    if (heightPx > maxHeightPx) {
      heightPx = maxHeightPx;
      widthPx = maxHeightPx * aspect;
    }
    const width = widthPx / format.width;
    const height = heightPx / format.height;
    return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
  };

  // Several events commonly share one sfx file (e.g. every "click" cue) —
  // cache its onset instead of re-running ffmpeg silencedetect per event.
  const audioOnsetCache = new Map<string, number>();
  const cachedAudioOnsetSec = (absPath: string, durationSec: number): number => {
    const cached = audioOnsetCache.get(absPath);
    if (cached !== undefined) return cached;
    const onset = audioOnsetSec(absPath, durationSec);
    audioOnsetCache.set(absPath, onset);
    return onset;
  };

  /**
   * Resolve a component ref's slot indirection against the job bindings:
   * textSlot → text param; imageSlot/audioSlot/videoSlot → src param;
   * textAnchor → text param from the anchor's captured words (optionally
   * shaped by a textTemplate containing "{captured}"), matched against
   * `blockId`'s own resolved roles — normally the event's OWN block, but a
   * ref may set `textAnchorBlockId` (a literal block id, e.g. a broll
   * block's stamp reusing a voice block's captured name) to reach across
   * blocks; the caller resolves that override into `blockId` before
   * calling this.
   * Returns a `skipReason` if a required slot/capture is unbound — specific
   * enough to show a user why an event never showed up, instead of a
   * server-only console.warn (the event is skipped either way).
   */
  const resolveComponentParams = (
    ref: ComponentRef,
    blockId: string,
  ): ResolvedComponent | { skipReason: string } => {
    const params: Record<string, unknown> = {};
    let audioDurationSec: number | undefined;
    let onsetSec: number | undefined;
    let mediaWidth: number | undefined;
    let mediaHeight: number | undefined;
    for (const [key, value] of Object.entries(ref.params)) {
      if (key === "textSlot") {
        const text = textAsset(filled, String(value));
        if (text === undefined) return { skipReason: `text slot "${value}" is not filled` };
        params.text = text;
      } else if (key === "imageSlot" || key === "audioSlot" || key === "videoSlot") {
        const asset = fileAsset(filled, String(value));
        if (!asset) {
          const kind = key === "imageSlot" ? "image" : key === "audioSlot" ? "audio" : "video";
          return { skipReason: `${kind} slot "${value}" is not filled` };
        }
        params.src = stage(asset);
        if (key === "audioSlot") {
          audioDurationSec = asset.durationSec;
          onsetSec = asset.durationSec !== undefined ? cachedAudioOnsetSec(asset.absPath, asset.durationSec) : 0;
        } else {
          mediaWidth = asset.width;
          mediaHeight = asset.height;
        }
      } else if (key === "textAnchor") {
        const captured = resolved.roles.find(
          (r) => r.blockId === blockId && r.roleId === String(value),
        )?.capturedText;
        if (captured === undefined) {
          return {
            skipReason: `anchor "${value}" has no captured text — its literal phrase wasn't matched in the transcript`,
          };
        }
        const template = ref.params.textTemplate;
        params.text =
          typeof template === "string" ? template.split("{captured}").join(captured) : captured;
      } else if (key === "textTemplate" || key === "textAnchorBlockId") {
        // Consumed alongside textAnchor above (textAnchorBlockId is
        // resolved into the `blockId` param this function was CALLED
        // with, by the caller, before we ever see it here).
      } else {
        params[key] = value;
      }
    }
    return { component: ref.component, params, audioDurationSec, audioOnsetSec: onsetSec, mediaWidth, mediaHeight };
  };

  /** Where an anchor's chosen edge (start/end/captureStart) actually lands. */
  const roleEdgeSec = (roleId: string, edge: "start" | "end" | "captureStart", blockId: string): number => {
    const role = resolved.roles.find((r) => r.blockId === blockId && r.roleId === roleId);
    if (!role) {
      throw new Error(`assemble: anchor "${roleId}" in block "${blockId}" was not resolved`);
    }
    return edge === "end"
      ? (role.endSec ?? role.timeSec)
      : edge === "captureStart"
        ? (role.captureStartSec ?? role.timeSec)
        : role.timeSec;
  };

  /** Resolve a timing (fixed anchor or anchor span edge) to trimmed-block
   *  seconds. Not for "sequence" timings — those go through
   *  resolveSequenceAtSec, which can drop an event instead of always
   *  returning a number. */
  const timingSec = (
    timing: FormatEvent["timing"],
    blockId: string,
    blockDurationSec: number,
  ): number => {
    if (timing.kind === "fixed") {
      return anchoredTimeSec(timing, blockDurationSec);
    }
    if (timing.kind === "sequence") {
      throw new Error(`assemble: a "sequence" timing can't be used as an "until" — only as an event's own timing`);
    }
    const edgeSec = roleEdgeSec(timing.roleId, timing.edge, blockId);
    return clamp(edgeSec + timing.offsetSec, 0, blockDurationSec);
  };

  /**
   * Places one member of a "sequence" timing: N sibling events distributed
   * across whatever runway exists after an anchor. Compresses spacing to
   * fit before ever dropping anything; if even the minimum spacing can't
   * fit everyone, drops from the tail (highest index first) rather than
   * collapsing every sibling onto the same instant.
   */
  const resolveSequenceAtSec = (
    timing: Extract<FormatEvent["timing"], { kind: "sequence" }>,
    blockId: string,
    blockDurationSec: number,
  ): { atSec: number } | { skipReason: string } => {
    const edgeSec = roleEdgeSec(timing.roleId, timing.edge, blockId);
    // Reserve minGapSec of daylight AFTER the last item too — otherwise the
    // last item's position lands exactly on blockDurationSec, leaving it
    // zero visible duration (and it gets dropped by the endSec<=atSec
    // guard) even though the spacing math "fit."
    const runwaySec = Math.max(0, blockDurationSec - edgeSec - timing.minGapSec);
    const maxFittable =
      timing.count <= 1 ? timing.count : clamp(Math.floor(runwaySec / timing.minGapSec) + 1, 0, timing.count);
    if (timing.index >= maxFittable) {
      return {
        skipReason:
          `sequence "${timing.roleId}" only fits ${maxFittable}/${timing.count} items in ` +
          `${runwaySec.toFixed(2)}s of runway after the anchor (need >=${timing.minGapSec.toFixed(2)}s each)`,
      };
    }
    const gap = timing.count > 1 ? Math.min(timing.targetGapSec, runwaySec / (timing.count - 1)) : 0;
    return { atSec: clamp(edgeSec + timing.index * gap, 0, Math.max(0, blockDurationSec - timing.minGapSec)) };
  };

  /** Event start relative to the block's trimmed start, overrides applied. */
  const eventTimeSec = (
    event: FormatEvent,
    blockId: string,
    blockDurationSec: number,
  ): { atSec: number } | { skipReason: string } => {
    const override = overrides?.events[event.id];
    if (override?.timeSec !== undefined) {
      return { atSec: clamp(override.timeSec, 0, blockDurationSec) };
    }
    if (event.timing.kind === "sequence") {
      return resolveSequenceAtSec(event.timing, blockId, blockDurationSec);
    }
    return { atSec: timingSec(event.timing, blockId, blockDurationSec) };
  };

  const video: EdlVideoSegment[] = [];
  const overlays: EdlOverlay[] = [];
  const sfx: EdlSfx[] = [];
  const captions: EdlCaptionGroup[] = [];
  const transitions: EdlTransition[] = [];
  const diagnostics: string[] = [...trims.diagnostics];
  /** Each block's own [tlInSec, tlOutSec) span, captured as the main loop
   *  places it — music placement/ducking (built after the loop) needs
   *  "where does the montage block start" and "where is every voice
   *  block's own span" without re-deriving the whole timeline. */
  const blockSpans = new Map<string, { tlInSec: number; tlOutSec: number }>();

  let cursor = 0;
  for (const block of format.blocks) {
    const trim = trims.blocks.find((b) => b.blockId === block.id);
    if (!trim) {
      // An `optional` block (see BlockSchema's doc comment) with no trim
      // entry simply was never filmed — not an error, the block just
      // doesn't appear in this video. Any other block missing a trim
      // entry is a real pipeline bug (every non-optional block gets one
      // from split/transcribe+trim), hence still a throw.
      if (block.optional) {
        diagnostics.push(`skipped block "${block.id}" — optional, not filmed (no "${block.videoSlot}" binding)`);
        continue;
      }
      throw new Error(`assemble: no trim points for block "${block.id}"`);
    }

    const blockDurationSec = trim.takes.reduce((s, t) => s + (t.srcOutSec - t.srcInSec), 0);
    const tlInSec = cursor;
    const tlOutSec = cursor + blockDurationSec;
    blockSpans.set(block.id, { tlInSec, tlOutSec });

    // A block is usually one clip (one take === the whole trim), but a
    // voice block's main clip may have been filmed as several separate
    // takes (see intake.ts/transcribe.ts) — here they're just N segments
    // laid back to back, sharing blockId. Multiple ids per block only
    // otherwise happens when the timeline editor splits a clip by hand.
    const takeFiles = block.kind === "broll" ? brollFile(filled, block) : videoTakeFiles(filled, block.videoSlot);
    const takeOrder =
      transcript.blocks.find((b) => b.blockId === block.id)?.takeOrder ?? takeFiles.map((_, i) => i);

    // karaokeTitle's own fg-alpha layer (backgroundReplace.ts, bound to
    // the synthetic "<videoSlot>-fg" key — same pattern as ecuCutaway's
    // own synthetic slot) covers the block's WHOLE span as one file, same
    // as backgroundReplace itself — only attached to the first segment,
    // which is the only one that exists for any single-take-derived voice
    // block (the only kind that ever sets captionVariant "karaokeTitle").
    const fgAsset = block.captionVariant === "karaokeTitle" ? fileAsset(filled, `${block.videoSlot}-fg`) : undefined;

    let segCursor = tlInSec;
    let lastSegId = block.id;
    trim.takes.forEach((t, i) => {
      const file = takeFiles[takeOrder[i] ?? i];
      const segId = trim.takes.length > 1 ? `${block.id}__take${i}` : block.id;
      const durationSec = t.srcOutSec - t.srcInSec;
      video.push({
        id: segId,
        blockId: block.id,
        src: stage(file),
        srcInSec: t.srcInSec,
        srcOutSec: t.srcOutSec,
        srcDurationSec: file.durationSec,
        tlInSec: segCursor,
        tlOutSec: segCursor + durationSec,
        // B-roll plays under the music/voice; its own audio is muted.
        muted: block.kind === "broll",
        volume: 1,
        fgSrc: i === 0 && fgAsset ? stage(fgAsset) : undefined,
      });
      segCursor += durationSec;
      lastSegId = segId;
    });

    for (const event of block.events) {
      const override = overrides?.events[event.id];
      const ref = override?.component ?? event.component;
      const textAnchorBlockId = typeof ref.params.textAnchorBlockId === "string" ? ref.params.textAnchorBlockId : block.id;
      const resolvedRef = resolveComponentParams(ref, textAnchorBlockId);
      if ("skipReason" in resolvedRef) {
        diagnostics.push(`skipped "${event.id}" in block "${block.id}" — ${resolvedRef.skipReason}`);
        continue;
      }
      const placement = eventTimeSec(event, block.id, blockDurationSec);
      if ("skipReason" in placement) {
        diagnostics.push(`skipped "${event.id}" in block "${block.id}" — ${placement.skipReason}`);
        continue;
      }
      const atSec = tlInSec + placement.atSec;
      // End priority: `until` (an anchor span edge) > durationSec > block end.
      const endSec = event.until
        ? tlInSec + timingSec(event.until, block.id, blockDurationSec)
        : event.durationSec
          ? Math.min(atSec + event.durationSec, tlOutSec)
          : tlOutSec;

      if (event.durationSec) {
        const authoredEndSec = atSec + event.durationSec;
        if (authoredEndSec > tlOutSec) {
          const clampedFrac = (authoredEndSec - endSec) / event.durationSec;
          if (clampedFrac > 0.2) {
            diagnostics.push(
              `"${event.id}" in block "${block.id}" clamped from ${event.durationSec.toFixed(2)}s to ` +
                `${(endSec - atSec).toFixed(2)}s (${Math.round(clampedFrac * 100)}% lost) — block ends before it authored`,
            );
          }
        }
      }

      if (event.kind === "overlay") {
        if (endSec <= atSec) {
          diagnostics.push(
            `skipped overlay "${event.id}" in block "${block.id}" — its "until" resolves before its start`,
          );
          continue;
        }
        const defaultBox = defaultOverlayBox(
          resolvedRef.component,
          resolvedRef.params,
          resolvedRef.mediaWidth,
          resolvedRef.mediaHeight,
        );
        overlays.push({
          id: event.id,
          component: resolvedRef.component,
          params: resolvedRef.params,
          tlInSec: atSec,
          tlOutSec: endSec,
          // A media overlay's default box fits the actual picture (see
          // defaultOverlayBox); anything else (text, composite cards)
          // defaults full-frame as before. Either way, the editor's canvas
          // drag/resize is what the user narrows/moves it with afterward.
          ...defaultBox,
        });
      } else {
        const volume = resolvedRef.params.volume;
        const srcInSec = resolvedRef.audioOnsetSec ?? 0;
        // SFX default to playing out; only an explicit end cuts them short.
        // "Playing out" means the cue's own natural length, not forever —
        // fall back to the source file's probed duration (minus its onset,
        // since playback now starts srcInSec into the file) so a one-shot
        // (bell, click, punchline stinger) actually unmounts once it's
        // done instead of staying mounted for the rest of the timeline.
        const explicitDurationSec =
          (event.until || event.durationSec) && endSec > atSec ? endSec - atSec : undefined;
        const playsOutDurationSec =
          resolvedRef.audioDurationSec !== undefined
            ? Math.max(0, resolvedRef.audioDurationSec - srcInSec)
            : undefined;
        sfx.push({
          id: event.id,
          src: String(resolvedRef.params.src),
          tlInSec: atSec,
          srcInSec,
          durationSec: explicitDurationSec ?? playsOutDurationSec,
          volume: typeof volume === "number" ? clamp(volume, 0, 1) : 1,
        });
      }
    }

    if (block.kind === "voice" && block.captions) {
      const rawTakes = transcript.blocks.find((b) => b.blockId === block.id)?.takes ?? [[]];
      const { words } = concatenateTakes(rawTakes, trim.takes);
      const theme = block.captionTheme;

      // A literal anchor's captured span is the format author's own signal
      // for "this is the thing that matters here" (a code's name, a
      // captured keyword) — free to derive, since resolveRoles already
      // computed it; no extra LLM call needed to know which words to
      // emphasize in the caption.
      const captureSpans = resolved.roles
        .filter((r) => r.blockId === block.id && r.captureStartSec !== undefined)
        .map((r) => ({ start: r.captureStartSec!, end: r.endSec ?? r.captureStartSec! }));
      const isEmphasized = (w: Word): boolean =>
        captureSpans.some((span) => w.startSec < span.end && w.endSec > span.start);

      if (block.captionVariant === "karaokeTitle") {
        // REPLACES lowerThird/bigTitle entirely (see schemas.ts's
        // captionVariant doc comment) — one group carrying EVERY word of
        // the block's own line, each with its own tlStartSec/tlEndSec;
        // KaraokeTitleLayer.tsx picks whichever word is active and shows
        // it full-screen, one at a time. No multi-word grouping/merging
        // needed here (that machinery exists to keep a lowerThird LINE
        // readable — karaokeTitle only ever shows one word).
        const karaokeWords = words.map((w) => {
          const tlStartSec = tlInSec + w.startSec;
          const tlEndSec = Math.max(tlInSec + w.endSec, tlStartSec + MIN_WORD_DURATION_SEC);
          return { text: w.text, tlStartSec, tlEndSec, emphasis: isEmphasized(w) };
        });
        if (karaokeWords.length > 0) {
          captions.push({
            id: `caption-${captions.length}`,
            words: karaokeWords,
            tlInSec: karaokeWords[0].tlStartSec,
            tlOutSec: Math.min(karaokeWords[karaokeWords.length - 1].tlEndSec + CAPTION_TAIL_SEC, tlOutSec),
            variant: "karaokeTitle",
            theme,
          });
        }
      } else {
        // Every captioned block ALWAYS gets ordinary multi-word lowerThird
        // coverage (see BlockSchema's captionVariant doc comment — bigTitle
        // is additive, not a replacement). Word ends are floored to
        // MIN_WORD_DURATION_SEC so a genuinely zero-duration whisper
        // timestamp can't seed a flash-frame group.
        let group: EdlCaptionGroup | null = null;
        for (const w of words) {
          const tlStartSec = tlInSec + w.startSec;
          const tlEndSec = Math.max(tlInSec + w.endSec, tlStartSec + MIN_WORD_DURATION_SEC);
          const lastEnd = group?.words[group.words.length - 1]?.tlEndSec ?? -Infinity;
          const startNew =
            !group ||
            group.words.length >= CAPTION_WORDS_PER_GROUP ||
            tlStartSec - lastEnd > CAPTION_GAP_SEC;
          if (startNew) {
            group = { id: `caption-${captions.length}`, words: [], tlInSec: tlStartSec, tlOutSec: tlEndSec, variant: "lowerThird", theme };
            captions.push(group);
          }
          group!.words.push({ text: w.text, tlStartSec, tlEndSec, emphasis: isEmphasized(w) });
          group!.tlOutSec = Math.min(tlEndSec + CAPTION_TAIL_SEC, tlOutSec);
        }
        // A lowerThird group stays up until the next lowerThird group takes
        // over — restricted to this block's own lowerThird groups, so a
        // bigTitle group pushed below (independent timing/lifetime) can't
        // get pulled into this chain or stretch a lowerThird line short.
        const lowerThirdGroups = captions.filter((g) => g.tlInSec >= tlInSec && g.variant === "lowerThird");
        for (let i = 0; i < lowerThirdGroups.length - 1; i++) {
          lowerThirdGroups[i].tlOutSec = lowerThirdGroups[i + 1].tlInSec;
        }
        // A group STILL shorter than the floor (the "extend to next" pass
        // can't rescue a block's own last group) gets merged into its
        // neighbor rather than rendered — see MIN_GROUP_DURATION_SEC. Merge
        // backward when possible (keeps reading order stable); forward only
        // for a block's very first group, which has no predecessor.
        for (let i = 0; i < lowerThirdGroups.length; i++) {
          const g = lowerThirdGroups[i];
          if (g.tlOutSec - g.tlInSec >= MIN_GROUP_DURATION_SEC) continue;
          const target = i > 0 ? lowerThirdGroups[i - 1] : lowerThirdGroups[i + 1];
          if (!target) continue; // this block's only group — nothing to merge into, leave it
          target.words.push(...g.words);
          target.tlInSec = Math.min(target.tlInSec, g.tlInSec);
          target.tlOutSec = Math.max(target.tlOutSec, g.tlOutSec);
          const idx = captions.indexOf(g);
          if (idx !== -1) captions.splice(idx, 1);
        }

        // bigTitle (additive): one full-screen card per picked keyword, held
        // for at least MIN_BIGTITLE_DURATION_SEC, independent of and
        // overlapping the lowerThird coverage above — see keywordTitle's
        // doc comment for how the word(s) are chosen.
        if (block.captionVariant === "bigTitle") {
          const config = block.keywordTitle ?? { source: "capture" as const, maxWords: 1 };
          let candidateWords: Word[];
          if (config.source === "capture") {
            candidateWords = words.filter((w) => captureSpans.some((span) => w.startSec < span.end && w.endSec > span.start));
          } else {
            const literalAnchor = block.anchors.find((a) => a.kind === "literal");
            const markerEndSec = literalAnchor ? roleEdgeSec(literalAnchor.id, "end", block.id) - tlInSec : 0;
            candidateWords = words.filter((w) => w.startSec >= markerEndSec);
          }
          const picked = pickKeywordWords(candidateWords, config.maxWords);
          for (const w of picked) {
            const tlStartSec = tlInSec + w.startSec;
            const tlEndSec = Math.max(tlInSec + w.endSec, tlStartSec + MIN_BIGTITLE_DURATION_SEC);
            captions.push({
              id: `caption-${captions.length}`,
              words: [{ text: w.text, tlStartSec, tlEndSec, emphasis: true }],
              tlInSec: tlStartSec,
              tlOutSec: Math.min(tlEndSec, tlOutSec),
              variant: "bigTitle",
              theme,
            });
          }
        }
      }
    }

    // ecuCutaway (see schemas.ts's BlockSchema doc comment): the ONLY
    // overlay type synthesized straight from a block flag rather than an
    // authored `events` entry — backgroundReplace.ts already produced the
    // cropped file at "<videoSlot>-ecu" by this point, so there's no
    // per-format event/slot boilerplate to write, just the one config.
    if (block.ecuCutaway) {
      const ecuAsset = fileAsset(filled, `${block.videoSlot}-ecu`);
      if (!ecuAsset) {
        diagnostics.push(`skipped ecuCutaway in block "${block.id}" — no "${block.videoSlot}-ecu" binding (backgroundReplace didn't run?)`);
      } else {
        const atSec = clamp(block.ecuCutaway.overlayAtSec, 0, blockDurationSec);
        const endSec = Math.min(atSec + block.ecuCutaway.durationSec, blockDurationSec);
        if (endSec > atSec) {
          overlays.push({
            id: `${block.id}-ecu-cutaway`,
            component: "CutawayOverlay",
            params: { src: stage(ecuAsset) },
            tlInSec: tlInSec + atSec,
            tlOutSec: tlInSec + endSec,
            ...defaultOverlayBox("CutawayOverlay", {}, ecuAsset.width, ecuAsset.height),
          });
        }
      }
    }

    const transitionRef = overrides?.transitions[block.id] ?? block.transitionAfter;
    if (transitionRef) {
      const durationSec =
        typeof transitionRef.params.durationSec === "number"
          ? transitionRef.params.durationSec
          : DEFAULT_TRANSITION_SEC;
      transitions.push({
        afterClipId: lastSegId,
        component: transitionRef.component,
        params: transitionRef.params,
        atSec: tlOutSec,
        durationSec,
      });
    }

    cursor = tlOutSec;
  }

  // Collapse duplicate simultaneous sfx: the same source firing within
  // SFX_DEDUPE_EPS_SEC of a cue already kept is the same beat re-triggering
  // (e.g. a "sequence" whose runway collapsed), not five intentional clicks
  // stacked louder than any one of them. Keeps the earliest of each cluster.
  const dedupedSfx: EdlSfx[] = [];
  for (const s of sfx) {
    const dupe = dedupedSfx.find(
      (d) => d.src === s.src && Math.abs(d.tlInSec - s.tlInSec) <= SFX_DEDUPE_EPS_SEC,
    );
    if (dupe) {
      diagnostics.push(`skipped sfx "${s.id}" — duplicate of "${dupe.id}" (same sound within ${SFX_DEDUPE_EPS_SEC}s)`);
      continue;
    }
    dedupedSfx.push(s);
  }

  // Music placement (see FormatSchema's musicPlacement doc comment): a
  // user-bound musicSlot wins; otherwise fall back to the format's own
  // checked-in template bed, when it has one (loadPlatesManifest throws
  // for a format with no plates at all — most formats, hence the guard).
  const buildMusic = (): Edl["music"][number] | undefined => {
    const boundAsset = format.musicSlot ? fileAsset(filled, format.musicSlot.name) : undefined;

    let src: string;
    let sourceDurationSec: number | undefined;
    if (boundAsset) {
      src = stage(boundAsset);
      sourceDurationSec = boundAsset.durationSec;
    } else {
      let manifest: ReturnType<typeof loadPlatesManifest> | undefined;
      try {
        manifest = loadPlatesManifest(format.id);
      } catch {
        manifest = undefined;
      }
      if (!manifest?.musicBed) {
        if (format.musicSlot) {
          diagnostics.push(
            `music slot "${format.musicSlot.name}" is not filled and the format has no default template bed — video will have no music`,
          );
        }
        return undefined;
      }
      const bedAbsPath = path.join(formatAssetsDir(format.id), manifest.musicBed.file);
      src = stageTemplateAsset(bedAbsPath, manifest.musicBed.file);
      sourceDurationSec = manifest.musicBed.durationSec;
    }

    const placement = format.musicPlacement ?? { mode: "start" as const, fadeInSec: 0.3, fadeOutSec: 0.6, duckVolume: 0.35 };

    let tlInSec = 0;
    if (placement.mode !== "start") {
      // Generic, not a hardcoded blockId: "the montage" is the EARLIEST
      // block generating a montageReel or triptych — both are silent
      // broll with no sfx/dialogue of their own, so if the montage isn't
      // the first of the two, starting music only at the montage leaves a
      // dead-silent gap under whichever one comes first (this shipped as
      // exactly that: 1.9s of true silence under a triptych placed before
      // the montage).
      const montageBlocks = format.blocks
        .filter((b) => b.slots.some((s) => s.generation?.kind === "montageReel" || s.generation?.kind === "triptych"))
        .map((b) => blockSpans.get(b.id))
        .filter((s): s is { tlInSec: number; tlOutSec: number } => s !== undefined);
      tlInSec = montageBlocks.length > 0 ? Math.min(...montageBlocks.map((s) => s.tlInSec)) : 0;
    }

    // `cursor` is finalized here — the main loop above has already run to
    // completion and left it holding the timeline's total duration.
    let srcInSec = 0;
    if (placement.mode === "endAlign" && sourceDurationSec !== undefined) {
      const availableSec = Math.max(0, cursor - tlInSec);
      srcInSec = Math.max(0, sourceDurationSec - availableSec);
    }
    // ALWAYS the timeline's own remaining length, never clamped down to
    // the source file's remaining length: a bed longer than the video has
    // left to run would otherwise push its fade-out's target end point
    // past the composition's actual final frame (never audibly reached);
    // a bed SHORTER than what's left would end naturally and leave the
    // remainder as true silence. EdlVideo.tsx loops the source to fill
    // this span either way — a short loop repeat under a quiet fade-out
    // reads as nothing; dead air for the video's last second does not.
    const remainingTimelineSec = Math.max(0, cursor - tlInSec);
    const durationSec = remainingTimelineSec;

    const duckWindows = format.blocks
      .filter((b) => b.kind === "voice")
      .map((b) => blockSpans.get(b.id))
      .filter((s): s is { tlInSec: number; tlOutSec: number } => s !== undefined);

    return {
      id: "music",
      src,
      volume: format.musicVolume,
      tlInSec,
      durationSec,
      srcInSec,
      fadeInSec: placement.fadeInSec,
      fadeOutSec: placement.fadeOutSec,
      duckVolume: placement.duckVolume,
      duckWindows,
    };
  };
  const builtMusic = buildMusic();
  const music = builtMusic ? [builtMusic] : [];

  // Only load a StyleProfile if the format actually has one — most formats
  // never will, and loadStyleProfile() warns on a miss (appropriate when
  // generate.ts calls it for a format that DOES need one for its generated
  // slots, noise here for formats that simply have none).
  const hasStyleProfile = fs.existsSync(path.join(formatStylesDir, `${format.id}.json`));
  const grade = hasStyleProfile ? loadStyleProfile(format.id).grade : undefined;

  // Only bother loading the plates manifest if some block actually uses
  // karaokeTitle — most formats won't, and loadPlatesManifest throws for
  // a format with no plates at all (same guard buildMusic uses above).
  let karaokeTitleBaselineFrac: number | undefined;
  const karaokeTitleBlocks = format.blocks.filter((b) => b.captionVariant === "karaokeTitle");
  if (karaokeTitleBlocks.length > 0) {
    try {
      karaokeTitleBaselineFrac = loadPlatesManifest(format.id).reference.talkingHead.headTopFrac;
      // backgroundReplace.ts's desk-overlap solve (see its own
      // solveDeskOverlap doc comment) can shift a block's framing down
      // from this manifest target, moving that block's actual head top
      // BELOW where the title's static baseline expects it. The EDL only
      // carries one global baseline (KaraokeTitleLayer applies it to every
      // karaokeTitle block alike — there's no per-block hook), so this
      // takes the LOWEST (most-shifted) actual head top across every
      // karaokeTitle block that shifted, favoring "title sits a little
      // higher than strictly necessary on an unshifted block" over "title
      // overlaps a shifted block's actual head" — the two failure
      // directions are not equally bad.
      const shifted = karaokeTitleBlocks
        .map((b) => filled.karaokeTitleBaselines?.[b.id])
        .filter((v): v is number => v !== undefined);
      if (shifted.length > 0) {
        karaokeTitleBaselineFrac = Math.min(karaokeTitleBaselineFrac, ...shifted);
      }
    } catch {
      karaokeTitleBaselineFrac = undefined;
    }
  }

  const edl: Edl = EdlSchema.parse({
    jobId: filled.jobId,
    formatId: format.id,
    fps: format.fps,
    width: format.width,
    height: format.height,
    durationSec: cursor,
    video,
    overlays,
    sfx: dedupedSfx,
    captions,
    captionStyle: format.captionStyle,
    grade,
    karaokeTitleBaselineFrac,
    transitions,
    music,
    assets,
    diagnostics,
  });

  return edl;
};

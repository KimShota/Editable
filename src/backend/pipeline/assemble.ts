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
} from "./types";
import { EdlSchema } from "./schemas";
import { anchoredTimeSec, clamp, concatenateTakes } from "./timing";
import { publicJobPrefix } from "./paths";

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
const DEFAULT_TRANSITION_SEC = 0.3;

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

  /**
   * Resolve a component ref's slot indirection against the job bindings:
   * textSlot → text param; imageSlot/audioSlot/videoSlot → src param;
   * textAnchor → text param from the anchor's captured words (optionally
   * shaped by a textTemplate containing "{captured}").
   * Returns null if a required slot/capture is unbound (event is skipped).
   */
  const resolveComponentParams = (
    ref: ComponentRef,
    blockId: string,
  ): { component: string; params: Record<string, unknown>; audioDurationSec?: number } | null => {
    const params: Record<string, unknown> = {};
    let audioDurationSec: number | undefined;
    for (const [key, value] of Object.entries(ref.params)) {
      if (key === "textSlot") {
        const text = textAsset(filled, String(value));
        if (text === undefined) return null;
        params.text = text;
      } else if (key === "imageSlot" || key === "audioSlot" || key === "videoSlot") {
        const asset = fileAsset(filled, String(value));
        if (!asset) return null;
        params.src = stage(asset);
        if (key === "audioSlot") audioDurationSec = asset.durationSec;
      } else if (key === "textAnchor") {
        const captured = resolved.roles.find(
          (r) => r.blockId === blockId && r.roleId === String(value),
        )?.capturedText;
        if (captured === undefined) return null;
        const template = ref.params.textTemplate;
        params.text =
          typeof template === "string" ? template.split("{captured}").join(captured) : captured;
      } else if (key === "textTemplate") {
        // Consumed alongside textAnchor above.
      } else {
        params[key] = value;
      }
    }
    return { component: ref.component, params, audioDurationSec };
  };

  /** Resolve a timing (fixed anchor or anchor span edge) to trimmed-block seconds. */
  const timingSec = (
    timing: FormatEvent["timing"],
    blockId: string,
    blockDurationSec: number,
  ): number => {
    if (timing.kind === "fixed") {
      return anchoredTimeSec(timing, blockDurationSec);
    }
    const role = resolved.roles.find(
      (r) => r.blockId === blockId && r.roleId === timing.roleId,
    );
    if (!role) {
      throw new Error(
        `assemble: anchor "${timing.roleId}" in block "${blockId}" was not resolved`,
      );
    }
    const edgeSec =
      timing.edge === "end"
        ? (role.endSec ?? role.timeSec)
        : timing.edge === "captureStart"
          ? (role.captureStartSec ?? role.timeSec)
          : role.timeSec;
    return clamp(edgeSec + timing.offsetSec, 0, blockDurationSec);
  };

  /** Event start relative to the block's trimmed start, overrides applied. */
  const eventTimeSec = (
    event: FormatEvent,
    blockId: string,
    blockDurationSec: number,
  ): number => {
    const override = overrides?.events[event.id];
    if (override?.timeSec !== undefined) {
      return clamp(override.timeSec, 0, blockDurationSec);
    }
    return timingSec(event.timing, blockId, blockDurationSec);
  };

  const video: EdlVideoSegment[] = [];
  const overlays: EdlOverlay[] = [];
  const sfx: EdlSfx[] = [];
  const captions: EdlCaptionGroup[] = [];
  const transitions: EdlTransition[] = [];

  let cursor = 0;
  for (const block of format.blocks) {
    const trim = trims.blocks.find((b) => b.blockId === block.id);
    if (!trim) throw new Error(`assemble: no trim points for block "${block.id}"`);

    const blockDurationSec = trim.takes.reduce((s, t) => s + (t.srcOutSec - t.srcInSec), 0);
    const tlInSec = cursor;
    const tlOutSec = cursor + blockDurationSec;

    // A block is usually one clip (one take === the whole trim), but a
    // voice block's main clip may have been filmed as several separate
    // takes (see intake.ts/transcribe.ts) — here they're just N segments
    // laid back to back, sharing blockId. Multiple ids per block only
    // otherwise happens when the timeline editor splits a clip by hand.
    const takeFiles = block.kind === "broll" ? brollFile(filled, block) : videoTakeFiles(filled, block.videoSlot);
    const takeOrder =
      transcript.blocks.find((b) => b.blockId === block.id)?.takeOrder ?? takeFiles.map((_, i) => i);

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
      });
      segCursor += durationSec;
      lastSegId = segId;
    });

    for (const event of block.events) {
      const override = overrides?.events[event.id];
      const ref = override?.component ?? event.component;
      const resolvedRef = resolveComponentParams(ref, block.id);
      if (!resolvedRef) {
        console.warn(
          `assemble: skipping event "${event.id}" — an optional slot/capture it needs is not filled`,
        );
        continue;
      }
      const atSec = tlInSec + eventTimeSec(event, block.id, blockDurationSec);
      // End priority: `until` (an anchor span edge) > durationSec > block end.
      const endSec = event.until
        ? tlInSec + timingSec(event.until, block.id, blockDurationSec)
        : event.durationSec
          ? Math.min(atSec + event.durationSec, tlOutSec)
          : tlOutSec;

      if (event.kind === "overlay") {
        if (endSec <= atSec) {
          console.warn(
            `assemble: skipping overlay "${event.id}" — its "until" resolves before its start`,
          );
          continue;
        }
        overlays.push({
          id: event.id,
          component: resolvedRef.component,
          params: resolvedRef.params,
          tlInSec: atSec,
          tlOutSec: endSec,
        });
      } else {
        const volume = resolvedRef.params.volume;
        // SFX default to playing out; only an explicit end cuts them short.
        // "Playing out" means the cue's own natural length, not forever —
        // fall back to the source file's probed duration so a one-shot
        // (bell, click, punchline stinger) actually unmounts once it's
        // done instead of staying mounted for the rest of the timeline.
        const explicitDurationSec =
          (event.until || event.durationSec) && endSec > atSec ? endSec - atSec : undefined;
        sfx.push({
          id: event.id,
          src: String(resolvedRef.params.src),
          tlInSec: atSec,
          durationSec: explicitDurationSec ?? resolvedRef.audioDurationSec,
          volume: typeof volume === "number" ? clamp(volume, 0, 1) : 1,
        });
      }
    }

    if (block.kind === "voice" && block.captions) {
      const rawTakes = transcript.blocks.find((b) => b.blockId === block.id)?.takes ?? [[]];
      const { words } = concatenateTakes(rawTakes, trim.takes);

      let group: EdlCaptionGroup | null = null;
      for (const w of words) {
        const tlStartSec = tlInSec + w.startSec;
        const tlEndSec = tlInSec + w.endSec;
        const lastEnd = group?.words[group.words.length - 1]?.tlEndSec ?? -Infinity;
        const startNew =
          !group ||
          group.words.length >= CAPTION_WORDS_PER_GROUP ||
          tlStartSec - lastEnd > CAPTION_GAP_SEC;
        if (startNew) {
          group = { id: `caption-${captions.length}`, words: [], tlInSec: tlStartSec, tlOutSec: tlEndSec };
          captions.push(group);
        }
        group!.words.push({ text: w.text, tlStartSec, tlEndSec });
        group!.tlOutSec = Math.min(tlEndSec + CAPTION_TAIL_SEC, tlOutSec);
      }
      // A group stays up until the next one takes over.
      const blockGroups = captions.filter((g) => g.tlInSec >= tlInSec);
      for (let i = 0; i < blockGroups.length - 1; i++) {
        blockGroups[i].tlOutSec = blockGroups[i + 1].tlInSec;
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

  const musicAsset = format.musicSlot ? fileAsset(filled, format.musicSlot.name) : undefined;

  const edl: Edl = EdlSchema.parse({
    jobId: filled.jobId,
    formatId: format.id,
    fps: format.fps,
    width: format.width,
    height: format.height,
    durationSec: cursor,
    video,
    overlays,
    sfx,
    captions,
    captionStyle: format.captionStyle,
    transitions,
    music: musicAsset ? { src: stage(musicAsset), volume: format.musicVolume } : undefined,
    assets,
  });

  return edl;
};

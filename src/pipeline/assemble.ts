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
import { anchoredTimeSec, clamp, toTrimmedWords } from "./timing";
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
   * textSlot → text param, imageSlot → src param, audioSlot → src param.
   * Returns null if a required slot is unbound (event should be skipped).
   */
  const resolveComponentParams = (
    ref: ComponentRef,
  ): { component: string; params: Record<string, unknown> } | null => {
    const params: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(ref.params)) {
      if (key === "textSlot") {
        const text = textAsset(filled, String(value));
        if (text === undefined) return null;
        params.text = text;
      } else if (key === "imageSlot" || key === "audioSlot") {
        const asset = fileAsset(filled, String(value));
        if (!asset) return null;
        params.src = stage(asset);
      } else {
        params[key] = value;
      }
    }
    return { component: ref.component, params };
  };

  /** Resolve a timing (fixed anchor or role) to trimmed-block seconds. */
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
        `assemble: role "${timing.roleId}" in block "${blockId}" was not resolved`,
      );
    }
    return clamp(role.timeSec, 0, blockDurationSec);
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
    const clip = fileAsset(filled, block.videoSlot);
    if (!clip) throw new Error(`assemble: block "${block.id}" has no bound clip`);

    const blockDurationSec = trim.srcOutSec - trim.srcInSec;
    const tlInSec = cursor;
    const tlOutSec = cursor + blockDurationSec;

    video.push({
      blockId: block.id,
      src: stage(clip),
      srcInSec: trim.srcInSec,
      srcOutSec: trim.srcOutSec,
      tlInSec,
      tlOutSec,
      // B-roll plays under the music/voice; its own audio is muted.
      muted: block.kind === "broll",
    });

    for (const event of block.events) {
      const override = overrides?.events[event.id];
      const ref = override?.component ?? event.component;
      const resolvedRef = resolveComponentParams(ref);
      if (!resolvedRef) {
        console.warn(
          `assemble: skipping event "${event.id}" — an optional slot it needs is not filled`,
        );
        continue;
      }
      const atSec = tlInSec + eventTimeSec(event, block.id, blockDurationSec);

      if (event.kind === "overlay") {
        // End priority: `until` (a role/anchor) > durationSec > block end.
        const overlayEnd = event.until
          ? tlInSec + timingSec(event.until, block.id, blockDurationSec)
          : event.durationSec
            ? Math.min(atSec + event.durationSec, tlOutSec)
            : tlOutSec;
        if (overlayEnd <= atSec) {
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
          tlOutSec: overlayEnd,
        });
      } else {
        const volume = resolvedRef.params.volume;
        sfx.push({
          id: event.id,
          src: String(resolvedRef.params.src),
          tlInSec: atSec,
          volume: typeof volume === "number" ? clamp(volume, 0, 1) : 1,
        });
      }
    }

    if (block.kind === "voice" && block.captions) {
      const rawWords = transcript.blocks.find((b) => b.blockId === block.id)?.words ?? [];
      const words = toTrimmedWords(rawWords, trim.srcInSec, blockDurationSec);

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
          group = { words: [], tlInSec: tlStartSec, tlOutSec: tlEndSec };
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
        afterBlockId: block.id,
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

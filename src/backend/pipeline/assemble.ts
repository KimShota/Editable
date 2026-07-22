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
/** Two sfx cues within this long of each other, from the same source file,
 *  are the same beat firing twice (e.g. a "sequence" whose runway collapsed
 *  before this fix) rather than two intentionally distinct sounds. */
const SFX_DEDUPE_EPS_SEC = 0.05;

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

  type ResolvedComponent = {
    component: string;
    params: Record<string, unknown>;
    audioDurationSec?: number;
  };

  /**
   * Resolve a component ref's slot indirection against the job bindings:
   * textSlot → text param; imageSlot/audioSlot/videoSlot → src param;
   * textAnchor → text param from the anchor's captured words (optionally
   * shaped by a textTemplate containing "{captured}").
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
        if (key === "audioSlot") audioDurationSec = asset.durationSec;
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
      } else if (key === "textTemplate") {
        // Consumed alongside textAnchor above.
      } else {
        params[key] = value;
      }
    }
    return { component: ref.component, params, audioDurationSec };
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

      if (event.kind === "overlay") {
        if (endSec <= atSec) {
          diagnostics.push(
            `skipped overlay "${event.id}" in block "${block.id}" — its "until" resolves before its start`,
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
    sfx: dedupedSfx,
    captions,
    captionStyle: format.captionStyle,
    transitions,
    music: musicAsset ? { src: stage(musicAsset), volume: format.musicVolume } : undefined,
    assets,
    diagnostics,
  });

  return edl;
};

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Edl, EdlCaptionGroup, EdlOverlay, EdlSfx, EdlVideoSegment } from "./types";
import { EdlSchema } from "./schemas";

/**
 * Module 8 — Timeline ops.
 *
 * Once a job reaches the editor, edl.json stops being a derived artifact
 * (the output of assemble()) and becomes the source of truth, the same way
 * a CapCut/Premiere project file is: every user gesture is a small,
 * reversible mutation applied directly to the document, not a request to
 * regenerate it. `assemble()` and the format are only ever consulted again
 * if the user explicitly resets the edit (see the /override route).
 *
 * applyOp is a pure reducer: (edl, op) -> edl. No filesystem access, no
 * pipeline stages — safe to unit test and safe to call from the API route,
 * which owns reading/writing edl.json and re-staging assets.
 *
 * The video track is kept CONTIGUOUS (no gaps) by convention, matching
 * assemble()'s cursor-based layout: every op that changes a clip's
 * duration or position on that track ends with recomputeVideoTrack, which
 * walks the array in order and re-lays tlIn/tlOut back to back. This is
 * what makes ripple trim/reorder/split/delete come "for free" from a
 * handful of array edits — no manual gap bookkeeping anywhere else.
 *
 * KNOWN LIMITATION: overlays/sfx/captions are not automatically retimed
 * when a video-track ripple shifts things around underneath them (no
 * "linked selection" yet). After a big ripple edit, secondary-track clips
 * may need a manual nudge — the same thing you'd see in an NLE with
 * linked selection turned off.
 */

const MIN_CLIP_SEC = 0.1;
/** Smallest an overlay's on-canvas box can shrink to, as a fraction of the
 *  composition — small enough to feel unconstrained, large enough that a
 *  handle never shrinks to something you can no longer grab. */
const MIN_OVERLAY_SIZE = 0.03;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

export const newClipId = (prefix: string): string => `${prefix}-${randomBytes(4).toString("hex")}`;

const ClipTrackSchema = z.enum(["video", "overlay", "sfx", "captions"]);
export type ClipTrack = z.infer<typeof ClipTrackSchema>;

export const TimelineOpSchema = z.discriminatedUnion("type", [
  /** Retime a free-floating clip (everything except the video track,
   *  which is always contiguous — repositioning a clip there means
   *  "reorder", not "move"). Music has exactly one instance, addressed
   *  by the MUSIC_ID sentinel rather than a real id. */
  z.object({
    type: z.literal("move"),
    track: z.enum(["overlay", "sfx", "captions", "music"]),
    id: z.string(),
    tlInSec: z.number().min(0),
  }),
  /** Drag a clip's start or end edge. Video: ripples the whole track.
   *  Everything else: resizes just that clip (or, for music, its window
   *  on the timeline — the source audio itself isn't trimmed). */
  z.object({
    type: z.literal("trimEdge"),
    track: z.enum(["video", "overlay", "sfx", "captions", "music"]),
    id: z.string(),
    edge: z.enum(["in", "out"]),
    tlSec: z.number().min(0),
  }),
  /** Reposition a clip in the video track's sequence (drag past a
   *  neighbor); the track re-flows contiguously afterward. */
  z.object({ type: z.literal("reorder"), id: z.string(), toIndex: z.number().int().min(0) }),
  /** Multi-select group-drag: shift every listed clip by the SAME delta in
   *  one atomic edit (one undo entry, one round-trip) — the video track is
   *  deliberately excluded, since "move" there would mean reordering
   *  several non-adjacent clips as a block, a fuzzier operation than a
   *  free-floating-track shift. */
  z.object({
    type: z.literal("moveMany"),
    track: z.enum(["overlay", "sfx", "captions"]),
    ids: z.array(z.string()).min(1),
    deltaSec: z.number(),
  }),
  /** The CANVAS equivalent of moveMany: multiple overlays' on-screen
   *  boxes (x/y — the spatial position, not when they play) shifted by
   *  the same delta in one atomic edit, for dragging one to move a
   *  multi-selected group together on the video preview. */
  z.object({
    type: z.literal("shiftOverlayBoxMany"),
    ids: z.array(z.string()).min(1),
    dx: z.number(),
    dy: z.number(),
  }),
  /** Reassign a transition to a different cut — dragging its marker onto
   *  another clip boundary. If that boundary already has a transition, the
   *  two swap places rather than one clobbering the other. */
  z.object({ type: z.literal("moveTransition"), fromId: z.string(), toId: z.string() }),
  /** Cut a clip into two at an absolute timeline second. */
  z.object({
    type: z.literal("split"),
    track: ClipTrackSchema,
    id: z.string(),
    atSec: z.number().min(0),
  }),
  /** Remove a clip. Video: ripples the gap closed. */
  z.object({ type: z.literal("delete"), track: ClipTrackSchema, id: z.string() }),
  /** Multi-select bulk delete: remove every listed clip in one atomic edit. */
  z.object({ type: z.literal("deleteMany"), track: ClipTrackSchema, ids: z.array(z.string()).min(1) }),
  /** Patch a clip's non-timing properties (component swap, volume,
   *  mute, transition swap). Never touches timing fields — those only
   *  ever move through the ops above, so the contiguity invariant can't
   *  be broken by accident. */
  z.object({
    type: z.literal("setProp"),
    track: z.enum(["video", "overlay", "sfx", "transition", "music", "captions"]),
    id: z.string().optional(),
    patch: z.record(z.string(), z.unknown()),
  }),
  /** Undo/redo: replaces the whole document with a snapshot the client
   *  already had (a previous server response). Still fully re-validated
   *  below — a client can't use this to write an arbitrary/malformed
   *  document, only one that was itself once a valid EDL. */
  z.object({ type: z.literal("restore"), edl: z.unknown() }),
]);
export type TimelineOp = z.infer<typeof TimelineOpSchema>;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Re-lays the video track back-to-back from t=0, in array order, using
 *  each segment's own (possibly just-changed) duration. This is the one
 *  function every video-track op ends with — it's what makes ripple
 *  trim/reorder/split/delete each a couple lines instead of bespoke
 *  gap-closing logic. */
const recomputeVideoTrack = (edl: Edl): void => {
  let cursor = 0;
  for (const seg of edl.video) {
    // Duration comes from the SOURCE range, not the old tl* fields — this
    // is what's changed by a trim/split before recompute re-lays timeline
    // positions from it.
    const duration = seg.srcOutSec - seg.srcInSec;
    seg.tlInSec = cursor;
    seg.tlOutSec = cursor + duration;
    cursor = seg.tlOutSec;
    const transition = edl.transitions.find((t) => t.afterClipId === seg.id);
    if (transition) transition.atSec = seg.tlOutSec;
  }
  const ends = [
    cursor,
    ...edl.overlays.map((o) => o.tlOutSec),
    ...edl.sfx.map((s) => s.tlInSec + (s.durationSec ?? 0)),
    ...edl.captions.map((c) => c.tlOutSec),
    ...(edl.music ? [edl.music.tlInSec + (edl.music.durationSec ?? 0)] : []),
  ];
  edl.durationSec = Math.max(...ends, MIN_CLIP_SEC);
};

const findIndexOrThrow = <T extends { id: string }>(arr: T[], id: string, what: string): number => {
  const i = arr.findIndex((c) => c.id === id);
  if (i === -1) throw new Error(`timeline op: ${what} "${id}" not found`);
  return i;
};

/** Shift one clip on a free-floating track by a relative delta — shared by
 *  the single-clip "move" (which derives its own delta from an absolute
 *  target) and the multi-select "moveMany" (which already has one). */
const shiftFloatingClip = (edl: Edl, track: "overlay" | "sfx" | "captions", id: string, deltaSec: number): void => {
  if (track === "overlay") {
    const clip = edl.overlays[findIndexOrThrow(edl.overlays, id, "overlay")];
    clip.tlInSec += deltaSec;
    clip.tlOutSec += deltaSec;
    return;
  }
  if (track === "sfx") {
    const clip = edl.sfx[findIndexOrThrow(edl.sfx, id, "sfx")];
    clip.tlInSec += deltaSec;
    return;
  }
  // captions — a rigid shift: the words move with the group, so the
  // per-word highlight timing stays aligned with when the group is on screen.
  const clip = edl.captions[findIndexOrThrow(edl.captions, id, "caption group")];
  clip.tlInSec += deltaSec;
  clip.tlOutSec += deltaSec;
  for (const w of clip.words) {
    w.tlStartSec += deltaSec;
    w.tlEndSec += deltaSec;
  }
};

const applyMove = (edl: Edl, op: Extract<TimelineOp, { type: "move" }>): void => {
  if (op.track === "music") {
    if (!edl.music) throw new Error("timeline op: job has no music bed to move");
    edl.music.tlInSec = Math.max(0, op.tlInSec);
    return;
  }
  const currentTlInSec =
    op.track === "overlay"
      ? edl.overlays[findIndexOrThrow(edl.overlays, op.id, "overlay")].tlInSec
      : op.track === "sfx"
        ? edl.sfx[findIndexOrThrow(edl.sfx, op.id, "sfx")].tlInSec
        : edl.captions[findIndexOrThrow(edl.captions, op.id, "caption group")].tlInSec;
  shiftFloatingClip(edl, op.track, op.id, op.tlInSec - currentTlInSec);
};

const applyMoveMany = (edl: Edl, op: Extract<TimelineOp, { type: "moveMany" }>): void => {
  for (const id of op.ids) shiftFloatingClip(edl, op.track, id, op.deltaSec);
};

const applyShiftOverlayBoxMany = (edl: Edl, op: Extract<TimelineOp, { type: "shiftOverlayBoxMany" }>): void => {
  for (const id of op.ids) {
    const clip = edl.overlays[findIndexOrThrow(edl.overlays, id, "overlay")];
    clip.x += op.dx;
    clip.y += op.dy;
  }
};

const applyTrimEdge = (edl: Edl, op: Extract<TimelineOp, { type: "trimEdge" }>): void => {
  if (op.track === "video") {
    const seg = edl.video[findIndexOrThrow(edl.video, op.id, "video clip")];
    const maxSrcOut = seg.srcDurationSec ?? seg.srcOutSec;
    if (op.edge === "in") {
      const delta = op.tlSec - seg.tlInSec;
      seg.srcInSec = clamp(seg.srcInSec + delta, 0, seg.srcOutSec - MIN_CLIP_SEC);
    } else {
      const delta = op.tlSec - seg.tlOutSec;
      seg.srcOutSec = clamp(seg.srcOutSec + delta, seg.srcInSec + MIN_CLIP_SEC, maxSrcOut);
    }
    recomputeVideoTrack(edl);
    return;
  }
  if (op.track === "overlay") {
    const clip = edl.overlays[findIndexOrThrow(edl.overlays, op.id, "overlay")];
    if (op.edge === "in") clip.tlInSec = clamp(op.tlSec, 0, clip.tlOutSec - MIN_CLIP_SEC);
    else clip.tlOutSec = Math.max(op.tlSec, clip.tlInSec + MIN_CLIP_SEC);
    return;
  }
  if (op.track === "captions") {
    const clip = edl.captions[findIndexOrThrow(edl.captions, op.id, "caption group")];
    if (op.edge === "in") clip.tlInSec = clamp(op.tlSec, 0, clip.tlOutSec - MIN_CLIP_SEC);
    else clip.tlOutSec = Math.max(op.tlSec, clip.tlInSec + MIN_CLIP_SEC);
    return;
  }
  if (op.track === "music") {
    if (!edl.music) throw new Error("timeline op: job has no music bed to trim");
    const m = edl.music;
    const currentEnd = m.tlInSec + (m.durationSec ?? Math.max(op.tlSec, m.tlInSec + MIN_CLIP_SEC));
    if (op.edge === "in") {
      const newIn = clamp(op.tlSec, 0, currentEnd - MIN_CLIP_SEC);
      m.durationSec = currentEnd - newIn;
      m.tlInSec = newIn;
    } else {
      m.durationSec = Math.max(op.tlSec - m.tlInSec, MIN_CLIP_SEC);
    }
    return;
  }
  // sfx
  const clip = edl.sfx[findIndexOrThrow(edl.sfx, op.id, "sfx")];
  const currentEnd = clip.tlInSec + (clip.durationSec ?? Math.max(op.tlSec, clip.tlInSec + MIN_CLIP_SEC));
  if (op.edge === "in") {
    const newIn = clamp(op.tlSec, 0, currentEnd - MIN_CLIP_SEC);
    clip.durationSec = currentEnd - newIn;
    clip.tlInSec = newIn;
  } else {
    clip.durationSec = Math.max(op.tlSec - clip.tlInSec, MIN_CLIP_SEC);
  }
};

const applyReorder = (edl: Edl, op: Extract<TimelineOp, { type: "reorder" }>): void => {
  const from = findIndexOrThrow(edl.video, op.id, "video clip");
  const [seg] = edl.video.splice(from, 1);
  const to = clamp(op.toIndex, 0, edl.video.length);
  edl.video.splice(to, 0, seg);
  recomputeVideoTrack(edl);
};

const applyMoveTransition = (edl: Edl, op: Extract<TimelineOp, { type: "moveTransition" }>): void => {
  if (op.fromId === op.toId) return;
  const from = edl.transitions.find((t) => t.afterClipId === op.fromId);
  if (!from) throw new Error(`timeline op: no transition after clip "${op.fromId}"`);
  const toIndex = findIndexOrThrow(edl.video, op.toId, "video clip");
  // The last clip has no "next" clip to blend into, so it can't host a
  // transition.
  if (toIndex === edl.video.length - 1) {
    throw new Error("timeline op: cannot move a transition after the last clip");
  }
  const toClip = edl.video[toIndex];
  const collision = edl.transitions.find((t) => t.afterClipId === op.toId);
  if (collision) {
    const fromClip = edl.video[findIndexOrThrow(edl.video, op.fromId, "video clip")];
    collision.afterClipId = op.fromId;
    collision.atSec = fromClip.tlOutSec;
  }
  from.afterClipId = op.toId;
  from.atSec = toClip.tlOutSec;
};

const applySplit = (edl: Edl, op: Extract<TimelineOp, { type: "split" }>): void => {
  if (op.track === "video") {
    const i = findIndexOrThrow(edl.video, op.id, "video clip");
    const seg = edl.video[i];
    if (op.atSec <= seg.tlInSec + MIN_CLIP_SEC || op.atSec >= seg.tlOutSec - MIN_CLIP_SEC) {
      throw new Error("timeline op: split point too close to a clip edge");
    }
    const proportion = (op.atSec - seg.tlInSec) / (seg.tlOutSec - seg.tlInSec);
    const splitSrcSec = seg.srcInSec + proportion * (seg.srcOutSec - seg.srcInSec);
    const secondId = newClipId(`${seg.id}-split`);
    const first: EdlVideoSegment = { ...seg, srcOutSec: splitSrcSec, tlOutSec: op.atSec };
    const second: EdlVideoSegment = {
      ...seg,
      id: secondId,
      srcInSec: splitSrcSec,
      tlInSec: op.atSec,
    };
    edl.video.splice(i, 1, first, second);
    // The original id's outgoing transition now sits at the second half's
    // trailing edge (the split itself is a hard cut, no transition).
    for (const t of edl.transitions) {
      if (t.afterClipId === seg.id) t.afterClipId = secondId;
    }
    recomputeVideoTrack(edl);
    return;
  }
  if (op.track === "overlay") {
    const i = findIndexOrThrow(edl.overlays, op.id, "overlay");
    const clip = edl.overlays[i];
    if (op.atSec <= clip.tlInSec + MIN_CLIP_SEC || op.atSec >= clip.tlOutSec - MIN_CLIP_SEC) {
      throw new Error("timeline op: split point too close to a clip edge");
    }
    const second: EdlOverlay = { ...clip, id: newClipId(`${clip.id}-split`), tlInSec: op.atSec };
    const first: EdlOverlay = { ...clip, tlOutSec: op.atSec };
    edl.overlays.splice(i, 1, first, second);
    return;
  }
  if (op.track === "captions") {
    const i = findIndexOrThrow(edl.captions, op.id, "caption group");
    const clip = edl.captions[i];
    if (op.atSec <= clip.tlInSec + MIN_CLIP_SEC || op.atSec >= clip.tlOutSec - MIN_CLIP_SEC) {
      throw new Error("timeline op: split point too close to a clip edge");
    }
    const firstWords = clip.words.filter((w) => w.tlStartSec < op.atSec);
    const secondWords = clip.words.filter((w) => w.tlStartSec >= op.atSec);
    if (firstWords.length === 0 || secondWords.length === 0) {
      throw new Error("timeline op: split point doesn't fall between two words");
    }
    const second: EdlCaptionGroup = {
      ...clip,
      id: newClipId(`${clip.id}-split`),
      words: secondWords,
      tlInSec: op.atSec,
    };
    const first: EdlCaptionGroup = { ...clip, words: firstWords, tlOutSec: op.atSec };
    edl.captions.splice(i, 1, first, second);
    return;
  }
  // sfx
  const i = findIndexOrThrow(edl.sfx, op.id, "sfx");
  const clip = edl.sfx[i];
  if (clip.durationSec === undefined) {
    throw new Error("timeline op: cannot split an sfx clip with no defined end");
  }
  const end = clip.tlInSec + clip.durationSec;
  if (op.atSec <= clip.tlInSec + MIN_CLIP_SEC || op.atSec >= end - MIN_CLIP_SEC) {
    throw new Error("timeline op: split point too close to a clip edge");
  }
  const second: EdlSfx = {
    ...clip,
    id: newClipId(`${clip.id}-split`),
    tlInSec: op.atSec,
    durationSec: end - op.atSec,
  };
  const first: EdlSfx = { ...clip, durationSec: op.atSec - clip.tlInSec };
  edl.sfx.splice(i, 1, first, second);
};

const applyDelete = (edl: Edl, op: Extract<TimelineOp, { type: "delete" }>): void => {
  if (op.track === "video") {
    if (edl.video.length <= 1) throw new Error("timeline op: cannot delete the last video clip");
    const i = findIndexOrThrow(edl.video, op.id, "video clip");
    edl.video.splice(i, 1);
    edl.transitions = edl.transitions.filter((t) => t.afterClipId !== op.id);
    recomputeVideoTrack(edl);
    return;
  }
  if (op.track === "overlay") {
    const i = findIndexOrThrow(edl.overlays, op.id, "overlay");
    edl.overlays.splice(i, 1);
    return;
  }
  if (op.track === "captions") {
    const i = findIndexOrThrow(edl.captions, op.id, "caption group");
    edl.captions.splice(i, 1);
    return;
  }
  const i = findIndexOrThrow(edl.sfx, op.id, "sfx");
  edl.sfx.splice(i, 1);
};

const applyDeleteMany = (edl: Edl, op: Extract<TimelineOp, { type: "deleteMany" }>): void => {
  const ids = new Set(op.ids);
  if (op.track === "video") {
    const remaining = edl.video.filter((v) => !ids.has(v.id));
    if (remaining.length === 0) throw new Error("timeline op: cannot delete every video clip");
    edl.video = remaining;
    edl.transitions = edl.transitions.filter((t) => !ids.has(t.afterClipId));
    recomputeVideoTrack(edl);
    return;
  }
  if (op.track === "overlay") {
    edl.overlays = edl.overlays.filter((o) => !ids.has(o.id));
    return;
  }
  if (op.track === "captions") {
    edl.captions = edl.captions.filter((c) => !ids.has(c.id));
    return;
  }
  edl.sfx = edl.sfx.filter((s) => !ids.has(s.id));
};

/** Allow-listed patch fields per track — the only properties setProp may
 *  touch. Timing fields are deliberately absent: they only ever move
 *  through move/trimEdge/reorder/split, so this can't break contiguity. */
const applySetProp = (edl: Edl, op: Extract<TimelineOp, { type: "setProp" }>): void => {
  if (op.track === "video") {
    const clip = edl.video[findIndexOrThrow(edl.video, op.id!, "video clip")];
    if (typeof op.patch.muted === "boolean") clip.muted = op.patch.muted;
    if (typeof op.patch.volume === "number") clip.volume = clamp(op.patch.volume, 0, 1);
    return;
  }
  if (op.track === "overlay") {
    const clip = edl.overlays[findIndexOrThrow(edl.overlays, op.id!, "overlay")];
    if (typeof op.patch.component === "string") clip.component = op.patch.component;
    if (op.patch.params && typeof op.patch.params === "object") {
      Object.assign(clip.params, op.patch.params as Record<string, unknown>);
    }
    // On-canvas box (see EdlOverlaySchema) — x/y are deliberately
    // unclamped (partially off-frame is a valid CapCut-style placement);
    // width/height only get a small positive floor.
    if (typeof op.patch.x === "number") clip.x = op.patch.x;
    if (typeof op.patch.y === "number") clip.y = op.patch.y;
    if (typeof op.patch.width === "number") clip.width = Math.max(op.patch.width, MIN_OVERLAY_SIZE);
    if (typeof op.patch.height === "number") clip.height = Math.max(op.patch.height, MIN_OVERLAY_SIZE);
    return;
  }
  if (op.track === "sfx") {
    const clip = edl.sfx[findIndexOrThrow(edl.sfx, op.id!, "sfx")];
    if (typeof op.patch.volume === "number") clip.volume = clamp(op.patch.volume, 0, 1);
    return;
  }
  if (op.track === "transition") {
    if (!op.id) throw new Error("timeline op: setProp on transition needs an id (afterClipId)");
    const component = typeof op.patch.component === "string" ? op.patch.component : undefined;
    const existingIndex = edl.transitions.findIndex((t) => t.afterClipId === op.id);

    // "cut" means no transition at all — remove the entry if one exists.
    if (component === "cut") {
      if (existingIndex !== -1) edl.transitions.splice(existingIndex, 1);
      return;
    }
    if (existingIndex === -1) {
      const clip = edl.video.find((v) => v.id === op.id);
      if (!clip) throw new Error(`timeline op: no video clip "${op.id}" to attach a transition after`);
      edl.transitions.push({
        afterClipId: op.id,
        component: component ?? "fade",
        params: (op.patch.params as Record<string, unknown>) ?? {},
        atSec: clip.tlOutSec,
        durationSec: typeof op.patch.durationSec === "number" ? Math.max(op.patch.durationSec, 0.05) : 0.3,
      });
      return;
    }
    const t = edl.transitions[existingIndex];
    if (component) t.component = component;
    if (op.patch.params && typeof op.patch.params === "object") {
      Object.assign(t.params, op.patch.params as Record<string, unknown>);
    }
    if (typeof op.patch.durationSec === "number") t.durationSec = Math.max(op.patch.durationSec, 0.05);
    return;
  }
  if (op.track === "captions") {
    const clip = edl.captions[findIndexOrThrow(edl.captions, op.id!, "caption group")];
    // Correcting a mis-transcription: the client sends a full replacement
    // words array (same length as before = each word keeps its original
    // timing; a different length = the client already redistributed new
    // timing evenly across the group's span) — this just trusts it,
    // re-validated by EdlSchema.parse at the end of applyOp either way.
    if (Array.isArray(op.patch.words) && op.patch.words.length > 0) {
      clip.words = op.patch.words as typeof clip.words;
    }
    return;
  }
  // music
  if (!edl.music) throw new Error("timeline op: job has no music bed to modify");
  if (typeof op.patch.volume === "number") edl.music.volume = clamp(op.patch.volume, 0, 1);
};

/** Applies one timeline op to an EDL and returns a new, validated document.
 *  Never mutates the input. Throws on an op that doesn't apply cleanly
 *  (unknown id, degenerate timing) — the caller (the API route) turns
 *  that into a 400 rather than persisting a broken document. */
export const applyOp = (edl: Edl, opInput: unknown): Edl => {
  const op = TimelineOpSchema.parse(opInput);

  // Restore ignores the current document entirely — it replaces it.
  if (op.type === "restore") return EdlSchema.parse(op.edl);

  const next = clone(edl);

  switch (op.type) {
    case "move":
      applyMove(next, op);
      break;
    case "trimEdge":
      applyTrimEdge(next, op);
      break;
    case "reorder":
      applyReorder(next, op);
      break;
    case "moveTransition":
      applyMoveTransition(next, op);
      break;
    case "split":
      applySplit(next, op);
      break;
    case "delete":
      applyDelete(next, op);
      break;
    case "deleteMany":
      applyDeleteMany(next, op);
      break;
    case "moveMany":
      applyMoveMany(next, op);
      break;
    case "shiftOverlayBoxMany":
      applyShiftOverlayBoxMany(next, op);
      break;
    case "setProp":
      applySetProp(next, op);
      break;
  }

  return EdlSchema.parse(next);
};

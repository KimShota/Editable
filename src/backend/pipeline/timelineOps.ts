import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Edl, EdlCaptionGroup, EdlOverlay, EdlSfx, EdlVideoSegment } from "./types";
import { EdlSchema } from "./schemas";
import { assertCaptionGroupCoversWords } from "./timing";

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
/** Linear-gain ceiling for a clip/sfx/music volume patch — matches the
 *  +20dB top of the editor's own dB slider (see decibels.ts) and the
 *  EDL schemas' own volume field max. */
const MAX_VOLUME = 10;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

export const newClipId = (prefix: string): string => `${prefix}-${randomBytes(4).toString("hex")}`;

const ClipTrackSchema = z.enum(["video", "overlay", "sfx", "captions"]);
export type ClipTrack = z.infer<typeof ClipTrackSchema>;

/** Tracks that support delete/deleteMany — the four real clips plus
 *  transition (removed by afterClipId) and music (own id, like sfx). */
const DeletableTrackSchema = z.enum(["video", "overlay", "sfx", "captions", "transition", "music"]);

export const TimelineOpSchema = z.discriminatedUnion("type", [
  /** Retime a free-floating clip (everything except the video track,
   *  which is always contiguous — repositioning a clip there means
   *  "reorder", not "move"). Music can have several simultaneous beds, so
   *  it's addressed by its own id exactly like overlay/sfx/captions. */
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
    track: z.enum(["overlay", "sfx", "captions", "music"]),
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
  /** Remove a clip. Video: ripples the gap closed. Transition: id is the
   *  afterClipId it's attached to. */
  z.object({ type: z.literal("delete"), track: DeletableTrackSchema, id: z.string() }),
  /** Multi-select bulk delete: remove every listed clip in one atomic edit. */
  z.object({ type: z.literal("deleteMany"), track: DeletableTrackSchema, ids: z.array(z.string()).min(1) }),
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
  /** Wire a newly-uploaded file into the timeline as an additional music
   *  bed (several may play simultaneously — see EdlMusicSchema). `src` is
   *  a public/-relative path the caller has already registered in
   *  edl.assets and staged to disk — this op only touches the EDL's own
   *  data, same division of labor as every other op here. */
  z.object({
    type: z.literal("addMusic"),
    src: z.string(),
    tlInSec: z.number().min(0).default(0),
    durationSec: z.number().positive().optional(),
  }),
  /** Wire a newly-uploaded file into the timeline as a one-shot sound
   *  effect at the given time. */
  z.object({
    type: z.literal("addSfx"),
    src: z.string(),
    tlInSec: z.number().min(0),
    durationSec: z.number().positive().optional(),
  }),
  /** Wire a newly-uploaded image/video file — or a brand-new TextOverlay,
   *  which has no file at all — into the timeline as an overlay. Box
   *  (x/y/width/height) is precomputed by the caller: from the media's own
   *  aspect ratio for Image/VideoOverlay (same as assemble.ts's own
   *  defaultOverlayBox), or from wherever the editor dropped it for a
   *  TextOverlay. `src` is absent for TextOverlay; `text` is ignored for
   *  the other two. */
  z.object({
    type: z.literal("addOverlay"),
    src: z.string().optional(),
    component: z.enum(["ImageOverlay", "VideoOverlay", "TextOverlay"]),
    text: z.string().optional(),
    tlInSec: z.number().min(0),
    tlOutSec: z.number().positive(),
    x: z.number().default(0),
    y: z.number().default(0),
    width: z.number().positive().default(1),
    height: z.number().positive().default(1),
  }),
  /** Wire a newly-uploaded video file into the timeline as a new clip
   *  appended to the end of the (contiguous) video track. */
  z.object({
    type: z.literal("addVideo"),
    src: z.string(),
    durationSec: z.number().positive(),
  }),
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
    ...edl.music.map((m) => m.tlInSec + (m.durationSec ?? 0)),
  ];
  edl.durationSec = Math.max(...ends, MIN_CLIP_SEC);
};

const findIndexOrThrow = <T extends { id: string }>(arr: T[], id: string, what: string): number => {
  const i = arr.findIndex((c) => c.id === id);
  if (i === -1) throw new Error(`timeline op: ${what} "${id}" not found`);
  return i;
};

/**
 * Captions render one group at a time in the finished video (Captions.tsx
 * picks whichever group's time window contains the current frame — first
 * array match wins). Unlike sfx/overlays, which can legitimately overlap
 * and play/show simultaneously, two caption groups can NEVER overlap: if
 * they did, one of them would just silently never appear for however long
 * their windows overlapped — which is exactly what "the one being dragged
 * disappears" is. So dragging one into another's time window snaps it to
 * start right after whichever group(s) it now overlaps, keeping its own
 * duration, instead of ever allowing the overlap to exist.
 *
 * One push can land inside a THIRD group sitting right after the one just
 * pushed past (captions often sit back-to-back with little gap) — so this
 * resolves in a loop until settled, not just once. The iteration cap is a
 * safety net against a pathological/cyclic edge case, not the expected
 * path; in practice this converges in 1-2 passes.
 */
const resolveCaptionOverlap = (edl: Edl, moved: EdlCaptionGroup): void => {
  for (let i = 0; i < edl.captions.length; i++) {
    const overlapping = edl.captions.filter(
      (g) => g.id !== moved.id && g.tlInSec < moved.tlOutSec && g.tlOutSec > moved.tlInSec,
    );
    if (overlapping.length === 0) return;
    const pushToSec = Math.max(...overlapping.map((g) => g.tlOutSec));
    const delta = pushToSec - moved.tlInSec;
    moved.tlInSec += delta;
    moved.tlOutSec += delta;
    for (const w of moved.words) {
      w.tlStartSec += delta;
      w.tlEndSec += delta;
    }
  }
};

/** Shift one clip on a free-floating track by a relative delta — shared by
 *  the single-clip "move" (which derives its own delta from an absolute
 *  target) and the multi-select "moveMany" (which already has one). */
const shiftFloatingClip = (
  edl: Edl,
  track: "overlay" | "sfx" | "captions" | "music",
  id: string,
  deltaSec: number,
): void => {
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
  if (track === "music") {
    const m = edl.music[findIndexOrThrow(edl.music, id, "music bed")];
    m.tlInSec = Math.max(0, m.tlInSec + deltaSec);
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
  resolveCaptionOverlap(edl, clip);
};

const applyMove = (edl: Edl, op: Extract<TimelineOp, { type: "move" }>): void => {
  if (op.track === "music") {
    const m = edl.music[findIndexOrThrow(edl.music, op.id, "music bed")];
    m.tlInSec = Math.max(0, op.tlInSec);
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
    // A caption's window must always cover its own words
    // (assertCaptionGroupCoversWords) or a word silently stops rendering.
    // That used to be enforced by CLAMPING the edge to the first/last
    // word, which made the edge immovable for the common case: assemble()
    // lays most groups' tlIn/tlOut exactly ON the first and last word, so
    // there is no slack to give and the drag did nothing at all.
    //
    // So dragging past a word now DROPS the words that fall outside the
    // new window and clips the straddling one back to the edge — the same
    // thing trimming a video clip does to footage, and what `split`
    // already does to a group's words. The invariant then holds by
    // construction instead of by refusal.
    const words = clip.words;
    if (op.edge === "in") {
      // Never past the last word's own end: a group must keep >= 1 word.
      const newIn = clamp(
        op.tlSec,
        0,
        Math.min(clip.tlOutSec - MIN_CLIP_SEC, words[words.length - 1].tlEndSec - MIN_CLIP_SEC),
      );
      const kept = words.filter((w) => w.tlEndSec > newIn);
      clip.words = kept.map((w, i) => (i === 0 ? { ...w, tlStartSec: Math.max(w.tlStartSec, newIn) } : w));
      clip.tlInSec = Math.min(newIn, clip.words[0].tlStartSec);
    } else {
      // Symmetrically, never before the first word's own start.
      const newOut = Math.max(op.tlSec, clip.tlInSec + MIN_CLIP_SEC, words[0].tlStartSec + MIN_CLIP_SEC);
      const kept = words.filter((w) => w.tlStartSec < newOut);
      clip.words = kept.map((w, i) =>
        i === kept.length - 1 ? { ...w, tlEndSec: Math.min(w.tlEndSec, newOut) } : w,
      );
      clip.tlOutSec = Math.max(newOut, clip.words[clip.words.length - 1].tlEndSec);
    }
    assertCaptionGroupCoversWords(clip);
    return;
  }
  if (op.track === "music") {
    const m = edl.music[findIndexOrThrow(edl.music, op.id, "music bed")];
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
    if (clip.words.length < 2) {
      throw new Error("timeline op: a one-word caption group has nothing to split");
    }
    // The cut has to land on a word boundary: each half's window must
    // cover its own words (assertCaptionGroupCoversWords) and words butt
    // up against each other, so there's no valid window edge INSIDE a
    // word. This used to reject any playhead that wasn't already between
    // two words — which is most of a group, since a playhead sitting
    // anywhere inside the last word left the second half wordless. Snap
    // to the nearest boundary instead: the user gets the split they asked
    // for, at the closest place it can legally go.
    //
    // A boundary sitting exactly on the group's own edge is skipped: real
    // transcripts do contain zero-duration words (whisper occasionally
    // emits one), and cutting there would leave a half with no duration
    // at all. Only interior boundaries can produce two real groups.
    const EPS = 1e-6;
    const cuts = clip.words
      .map((w, j) => ({ j, at: w.tlStartSec }))
      .filter(({ j, at }) => j > 0 && at > clip.tlInSec + EPS && at < clip.tlOutSec - EPS);
    if (cuts.length === 0) {
      throw new Error("timeline op: this caption group has no word boundary inside it to split on");
    }
    let cut = cuts[0].j;
    for (const c of cuts) {
      if (Math.abs(c.at - op.atSec) < Math.abs(clip.words[cut].tlStartSec - op.atSec)) cut = c.j;
    }
    const boundarySec = clip.words[cut].tlStartSec;
    // Real transcripts occasionally have words whose spans OVERLAP, so the
    // word before the cut can end after the word at the cut begins. Letting
    // the first half stretch to cover it would push its window past the
    // second half's start, and two caption groups may never overlap — the
    // renderer shows the first match for a given moment, so the second
    // would silently not appear (the same failure resolveCaptionOverlap
    // exists to prevent). Clipping that one word back to the boundary
    // costs a few hundredths of a second of highlight and keeps both
    // halves well-formed, which is the same trade trimming an edge makes.
    const firstWords = clip.words.slice(0, cut);
    const lastOfFirst = firstWords[firstWords.length - 1];
    firstWords[firstWords.length - 1] = {
      ...lastOfFirst,
      tlEndSec: Math.max(Math.min(lastOfFirst.tlEndSec, boundarySec), lastOfFirst.tlStartSec),
    };
    const second: EdlCaptionGroup = {
      ...clip,
      id: newClipId(`${clip.id}-split`),
      words: clip.words.slice(cut),
      tlInSec: boundarySec,
    };
    const first: EdlCaptionGroup = { ...clip, words: firstWords, tlOutSec: boundarySec };
    assertCaptionGroupCoversWords(first);
    assertCaptionGroupCoversWords(second);
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
  if (op.track === "transition") {
    const i = edl.transitions.findIndex((t) => t.afterClipId === op.id);
    if (i === -1) throw new Error(`timeline op: transition after "${op.id}" not found`);
    edl.transitions.splice(i, 1);
    return;
  }
  if (op.track === "music") {
    const i = findIndexOrThrow(edl.music, op.id, "music bed");
    edl.music.splice(i, 1);
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
  if (op.track === "transition") {
    edl.transitions = edl.transitions.filter((t) => !ids.has(t.afterClipId));
    return;
  }
  if (op.track === "music") {
    edl.music = edl.music.filter((m) => !ids.has(m.id));
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
    if (typeof op.patch.volume === "number") clip.volume = clamp(op.patch.volume, 0, MAX_VOLUME);
    return;
  }
  if (op.track === "overlay") {
    const clip = edl.overlays[findIndexOrThrow(edl.overlays, op.id!, "overlay")];
    if (typeof op.patch.component === "string") clip.component = op.patch.component;
    if (op.patch.params && typeof op.patch.params === "object") {
      // An explicit null deletes the key (back to the component's own
      // default — see TextOverlay's variant fallback) rather than setting
      // a literal null param; anything else sets/replaces it. Plain
      // Object.assign couldn't express "delete", which the Inspector's
      // "Reset to template style" needs per-field.
      for (const [key, value] of Object.entries(op.patch.params as Record<string, unknown>)) {
        if (value === null) delete clip.params[key];
        else clip.params[key] = value;
      }
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
    if (typeof op.patch.volume === "number") clip.volume = clamp(op.patch.volume, 0, MAX_VOLUME);
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
    // Canvas drag: the group's own on-screen position (see
    // EdlCaptionGroupSchema). An explicit null on either axis means "put
    // this back on automatic placement" — checked separately from a
    // MISSING key, since `patch` only ever carries the fields the client
    // actually meant to change, so absent must keep the current value.
    if (op.patch.x === null || op.patch.y === null) {
      delete clip.x;
      delete clip.y;
    } else if (typeof op.patch.x === "number" && typeof op.patch.y === "number") {
      // Clamped so a caption can never be dragged fully off-frame into a
      // position it can't be grabbed back from.
      clip.x = clamp(op.patch.x, 0, 1);
      clip.y = clamp(op.patch.y, 0, 1);
    }
    // Typography override (see EdlCaptionGroupSchema doc comment) — same
    // "explicit null deletes the field, back to the template's own
    // automatic style" contract as x/y above and as the overlay branch's
    // params loop, so the Inspector's "Reset to template style" and a
    // corner-drag's resize-the-font both work the same way here as they
    // do for a TextOverlay event.
    const captionStyleKeys = ["fontSize", "fontFamily", "color", "fontWeight", "italic", "underline", "textCase"] as const;
    for (const key of captionStyleKeys) {
      if (!(key in op.patch)) continue;
      const value = op.patch[key];
      if (value === null) delete clip[key];
      else (clip as Record<string, unknown>)[key] = value;
    }
    return;
  }
  // music
  const m = edl.music[findIndexOrThrow(edl.music, op.id!, "music bed")];
  if (typeof op.patch.volume === "number") m.volume = clamp(op.patch.volume, 0, MAX_VOLUME);
};

const applyAddMusic = (edl: Edl, op: Extract<TimelineOp, { type: "addMusic" }>): void => {
  edl.music.push({
    id: newClipId("music"),
    src: op.src,
    volume: 0.5,
    tlInSec: op.tlInSec,
    durationSec: op.durationSec,
    srcInSec: 0,
    fadeInSec: 0,
    fadeOutSec: 0,
    duckVolume: 1,
    duckWindows: [],
  });
  recomputeVideoTrack(edl);
};

const applyAddSfx = (edl: Edl, op: Extract<TimelineOp, { type: "addSfx" }>): void => {
  edl.sfx.push({
    id: newClipId("sfx"),
    src: op.src,
    tlInSec: op.tlInSec,
    srcInSec: 0,
    durationSec: op.durationSec,
    volume: 1,
  });
  recomputeVideoTrack(edl);
};

const applyAddOverlay = (edl: Edl, op: Extract<TimelineOp, { type: "addOverlay" }>): void => {
  edl.overlays.push({
    id: newClipId("overlay"),
    component: op.component,
    params: op.component === "TextOverlay" ? { text: op.text ?? "Text" } : { src: op.src },
    tlInSec: op.tlInSec,
    tlOutSec: op.tlOutSec,
    x: op.x,
    y: op.y,
    width: op.width,
    height: op.height,
    states: [],
  });
  recomputeVideoTrack(edl);
};

const applyAddVideo = (edl: Edl, op: Extract<TimelineOp, { type: "addVideo" }>): void => {
  const id = newClipId("video");
  edl.video.push({
    id,
    blockId: id,
    src: op.src,
    srcInSec: 0,
    srcOutSec: op.durationSec,
    srcDurationSec: op.durationSec,
    tlInSec: 0,
    tlOutSec: 0,
    muted: false,
    volume: 1,
  });
  recomputeVideoTrack(edl);
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
    case "addMusic":
      applyAddMusic(next, op);
      break;
    case "addSfx":
      applyAddSfx(next, op);
      break;
    case "addOverlay":
      applyAddOverlay(next, op);
      break;
    case "addVideo":
      applyAddVideo(next, op);
      break;
  }

  return EdlSchema.parse(next);
};

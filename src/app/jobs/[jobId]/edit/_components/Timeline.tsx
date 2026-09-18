"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Edl, EdlTrack } from "@backend/pipeline/types";
import {
  overlayTrackKind,
  PIP_DEFAULT_BOX,
  type TimelineOp,
  type TrackKind,
} from "@backend/pipeline/timelineOps";
import { previewProxySrc } from "@backend/remotion/previewSrc";
import { TimelineClip } from "./TimelineClip";
import { assignLanes, laneCount } from "./lanes";
import {
  isSelected,
  MediaKind,
  Selection,
  SelectionTrack,
  toggleSelect,
} from "./selection";
import { buildMajorLadder, chooseTickScale, formatTick } from "./tickScale";
import {
  FitIcon,
  MagnetIcon,
  ScissorsIcon,
  TrashIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "./Icons";
import { TEXT_OVERLAY_DRAG_TYPE, buildAddTextOverlayOp } from "./textOverlay";
import {
  clipEdgeTargets,
  resolveSnap,
  snapPoint,
  type SnapResult,
  type SnapTarget,
} from "./snapping";
import {
  dropTargetKey,
  mainCuts,
  resolveDropTarget,
  type DragFamily,
  type DragPayload,
  type DropTarget,
  type Interval,
  type RowHit,
} from "./dropTarget";
import {
  dragFamilyFromTransfer,
  fileFamily,
  readAssetDragData,
  type AssetDragPayload,
} from "./assetDrag";

/** One hue family (indigo → violet → purple) so tracks read as a system;
 *  transitions get the one intentional exception (amber) since they're a
 *  different kind of thing — an effect marker, not a content clip. */
const TRACK_COLOR = {
  video: "bg-indigo-500/85",
  // Picture-in-picture layers: same indigo as the main reel (it's still
  // footage) a step lighter, so a lifted clip visibly reads as "above"
  // the main track rather than as a different kind of thing entirely.
  pip: "bg-indigo-400/80",
  transition: "bg-amber-500/75",
  // Text and captions each get their own rows, but keep the violet family
  // so they still read as "both text" — captions get the darker sibling
  // shade so a caption chip still looks distinct from a title bar, same
  // as sfx/music stay distinguishable from each other despite both being
  // audio.
  text: "bg-violet-500/80",
  sfx: "bg-purple-400/75",
  captions: "bg-violet-700/85",
  music: "bg-indigo-900/85",
} as const;

/** How long a dropped image or text card runs by default — mirrors the
 *  media route's IMAGE_OVERLAY_DEFAULT_SEC and textOverlay.ts's own. */
const DEFAULT_STILL_SEC = 3;
/** Height of the dashed "new layer" placeholder shown while a drag is
 *  about to create one — shorter than a real row so it reads as a
 *  promise, not a track that already exists. */
const GHOST_ROW_HEIGHT = 34;

const TRACK_LABEL_WIDTH = 96;
/** Frame-level precision: enough px/frame that individual frames are
 *  visually distinct once fully zoomed in. */
const PX_PER_FRAME_AT_MAX_ZOOM = 12;
/** Height of one clip lane — matches the track row's old fixed h-14. A
 *  track with overlapping clips grows to laneCount * LANE_HEIGHT tall. */
const LANE_HEIGHT = 56;
/** Below this drag distance, a marquee gesture is just a click (deselect),
 *  not an intentional rubber-band selection. */
const MARQUEE_THRESHOLD_PX = 4;
/** How long a discrete zoom step (the toolbar's buttons) takes to play
 *  out. Long enough to read as the timeline expanding around a fixed
 *  point rather than cutting to a new scale, short enough not to feel
 *  sluggish — and since every frame of it re-renders the track rows (the
 *  very thing TimelineTracks' memoization exists to avoid), it's
 *  deliberately brief. */
const ZOOM_ANIM_MS = 180;
/** Snapping is a working preference, not per-project state — someone who
 *  turns it off wants it off for the next clip and the next session too,
 *  not just this job. Kept out of the EDL for exactly that reason. */
const SNAP_PREF_KEY = "editable-editor-snap";

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), hi);

// Stable array references — an inline `["in", "out"]` literal at a call
// site is a fresh array every render, which would defeat TimelineTracks'
// memoization even though the two track-color/trim-edge configs never
// actually change.
const BOTH_TRIM_EDGES: ("in" | "out")[] = ["in", "out"];
const OUT_TRIM_EDGE_ONLY: ("in" | "out")[] = ["out"];

type ClipView = {
  id: string;
  tlInSec: number;
  tlOutSec: number;
  label: string;
  sublabel?: string;
  thumbnailSrc?: string;
  /** A video/audio clip's own source — decoded client-side into a waveform
   *  drawn inside the clip. See TimelineClip's own doc comment. */
  waveformSrc?: string;
  waveformInSec?: number;
  waveformOutSec?: number;
  /** Which EDL array this clip actually lives in — unset for every row
   *  rendered per-track below (Overlays/Captions/Music/SFX each render one
   *  row per EdlTrack of their own kind), kept only because TrackRow's
   *  handlers still read `c.track ?? track` and fall back to the row's own
   *  fixed `track` prop. */
  track?: "sfx" | "music" | "overlay" | "captions";
  /** Which EdlTrack (layer) this clip is parked on — see schemas.ts's
   *  EdlTrackSchema doc comment. Absent for video/transition clips, which
   *  have no track concept. */
  trackId?: string;
  /** Which family of track this clip may be dropped on when dragged — see
   *  dropTarget.ts. Footage (a main-track segment or a VideoOverlay) is
   *  the one thing that can land on the main reel; every other clip only
   *  ever moves between layers of its own kind. */
  family: DragFamily;
};

/** The four EDL arrays a free-floating clip can live in — what ops and
 *  the selection address a clip by. Coarser than TrackKind: `overlay`
 *  clips are split across `overlay` (picture-in-picture) and `text`
 *  tracks by component. */
type FloatTrack = "overlay" | "sfx" | "captions" | "music";

/** One row's worth of clips, already filtered to one specific EdlTrack —
 *  what TrackRow actually renders now, instead of every clip of a whole
 *  kind sharing one auto-lane-packed row. */
type TrackGroup = { track: EdlTrack; clips: ClipView[] };

/** Splits one kind's flat clip list into one group per EdlTrack, in the
 *  SAME order `edl.tracks` lists them (so a layer a drop just created
 *  appears where they'd expect — at the bottom of its kind's section —
 *  and reordering `edl.tracks` — not wired up yet, but the data already
 *  supports it — would reorder rows for free). A clip whose trackId
 *  doesn't match any given track (should only happen for one render frame
 *  between an edit and the server's normalized response) is silently
 *  dropped rather than crashing — the authoritative response replaces it
 *  immediately after. */
const groupByTrack = (
  tracks: EdlTrack[],
  kind: TrackKind,
  clips: ClipView[],
): TrackGroup[] =>
  tracks
    .filter((t) => t.kind === kind)
    .map((track) => ({
      track,
      clips: clips.filter((c) => c.trackId === track.id),
    }));

/** Row registry key for a free-floating layer — the same string the drop
 *  hit-test parses back into a RowHit. The main reel registers as "main". */
const rowKeyFor = (kind: TrackKind, trackId: string) => `${kind}:${trackId}`;
const MAIN_ROW_KEY = "main";

/** Resolves one drag against every other clip's boundaries — see snapping.ts.
 *  Built once by Timeline (which is the only thing that can see all the
 *  tracks at once) and handed down to every row. */
type DragSnapResolver = (input: {
  edgesSec: number[];
  excludeKeys: string[];
  rawDeltaPx: number;
}) => SnapResult;

/**
 * One track's label + clips + the interactive background that starts a
 * marquee (rubber-band) selection. A real component (not a plain function
 * returning JSX, which the old single-select version could get away with)
 * because the marquee gesture needs its own local drag state per row.
 */
function TrackRow({
  label,
  clips,
  colorClass,
  handlers,
  track,
  selection,
  onSelect,
  onGroupMove,
  pxPerSec,
  locked = false,
  trimEdges = BOTH_TRIM_EDGES,
  resolveDragSnap,
  onSnapGuide,
  snapMove = true,
  registerRow,
  rowKey,
  highlighted = false,
  insertMarkerSec = null,
}: {
  label: string;
  clips: ClipView[];
  colorClass: string;
  handlers: {
    // The track argument is only meaningful for a row that mixes clips
    // from more than one EDL array (the merged Audio row) — it's each
    // clip's own resolved track (c.track ?? the row's fixed `track` prop),
    // so a single-track row's handlers can just ignore the third arg,
    // same as they always have. `clientY` is the drag's screen position,
    // passed straight through from TimelineClip — only "move"/"dragMove"
    // need it (a candidate cross-layer retrack), never "trim".
    move?: (
      id: string,
      deltaSec: number,
      track: SelectionTrack,
      clientY: number,
    ) => void;
    /** Live counterpart of `move` — fired throughout the drag so the
     *  timeline can preview where the clip will land; `dragEnd` takes
     *  that preview down again however the drag finishes. */
    dragMove?: (
      id: string,
      deltaSec: number,
      track: SelectionTrack,
      clientY: number,
    ) => void;
    dragEnd?: () => void;
    trim?: (
      id: string,
      edge: "in" | "out",
      deltaSec: number,
      track: SelectionTrack,
    ) => void;
  };
  track: SelectionTrack;
  selection: Selection;
  onSelect: (s: Selection) => void;
  /** Only the free-floating tracks support "drag one, group moves
   *  together" — video is contiguous (reorder, not a free move) and
   *  transition is always addressed by its own single afterClipId. */
  onGroupMove?: (track: FloatTrack, ids: string[], deltaSec: number) => void;
  pxPerSec: number;
  locked?: boolean;
  trimEdges?: ("in" | "out")[];
  resolveDragSnap?: DragSnapResolver;
  onSnapGuide?: (sec: number | null) => void;
  /** Whether a whole-clip drag snaps, as opposed to only its trim edges.
   *  Off for the video row: a video drag doesn't move a clip to a time, it
   *  reorders it among its neighbours (see commitClipDrag), so latching its
   *  edge onto a boundary would promise a landing spot the commit doesn't
   *  honour. Trimming a video clip DOES set a real time, so that still
   *  snaps. */
  snapMove?: boolean;
  /** Registers this row's own screen bounds under `rowKey` (undoing the
   *  registration on unmount) so a drop anywhere on the timeline can be
   *  hit-tested against every row's real position — see Timeline's own
   *  pickRowAt. Omitted only for the Transitions row, which nothing can
   *  be dropped onto. */
  registerRow?: (key: string, el: HTMLDivElement | null) => void;
  rowKey?: string;
  /** True while a live drag is about to land on THIS row — the row tints
   *  so the answer to "where will this go?" is visible before release. */
  highlighted?: boolean;
  /** Main reel only: the cut a dragged clip is about to be inserted at,
   *  drawn as a vertical marker — the magnetic track's version of "here". */
  insertMarkerSec?: number | null;
}) {
  const lanes = useMemo(() => assignLanes(clips), [clips]);
  const rowHeight = laneCount(lanes) * LANE_HEIGHT;
  // The clips area (after the label gutter) — marquee coordinates are
  // relative to this, since that's where clips are positioned from.
  const containerRef = useRef<HTMLDivElement>(null);
  // The WHOLE row, label included, is what registers for drop hit-testing
  // — a clip dragged over the sticky label gutter is still over this row.
  // Memoized on rowKey/registerRow (both stable across a row's own
  // lifetime) so React doesn't see a new ref callback identity every
  // render — an unstable one would detach/reattach (null, then the
  // element again) on every re-render instead of only on real mount/
  // unmount, needlessly churning Timeline's own row registry.
  const setRowRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (rowKey) registerRow?.(rowKey, el);
    },
    [rowKey, registerRow],
  );
  const [marquee, setMarquee] = useState<{
    startX: number;
    startY: number;
    curX: number;
    curY: number;
    additive: boolean;
  } | null>(null);

  const beginMarquee = (e: React.PointerEvent) => {
    // Clips stopPropagation on their own pointerdown, so this only ever
    // fires for a genuine click/drag on the row's empty background.
    const rect = containerRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Shift or Cmd/Ctrl — see TimelineClip's beginDrag for why both.
    setMarquee({
      startX: x,
      startY: y,
      curX: x,
      curY: y,
      additive: e.shiftKey || e.metaKey || e.ctrlKey,
    });
  };

  const onMarqueeMove = (e: React.PointerEvent) => {
    if (!marquee) return;
    const rect = containerRef.current!.getBoundingClientRect();
    setMarquee((m) =>
      m ? { ...m, curX: e.clientX - rect.left, curY: e.clientY - rect.top } : m,
    );
  };

  const endMarquee = (e: React.PointerEvent) => {
    if (!marquee) return;
    e.stopPropagation();
    const x0 = Math.min(marquee.startX, marquee.curX);
    const x1 = Math.max(marquee.startX, marquee.curX);
    const y0 = Math.min(marquee.startY, marquee.curY);
    const y1 = Math.max(marquee.startY, marquee.curY);
    const dragged =
      x1 - x0 > MARQUEE_THRESHOLD_PX || y1 - y0 > MARQUEE_THRESHOLD_PX;
    const additive = marquee.additive;
    setMarquee(null);

    if (!dragged) {
      if (!additive) onSelect(null);
      return;
    }
    const hitClips = clips.filter((c) => {
      const left = c.tlInSec * pxPerSec;
      const width = (c.tlOutSec - c.tlInSec) * pxPerSec;
      const top = (lanes.get(c.id) ?? 0) * LANE_HEIGHT;
      return (
        left < x1 && left + width > x0 && top < y1 && top + LANE_HEIGHT > y0
      );
    });

    if (hitClips.length === 0) {
      if (!additive) onSelect(null);
      return;
    }
    // A row that mixes tracks (the merged Audio row) can sweep over both
    // sfx and music clips at once — a Selection only ever spans one real
    // track (see selection.ts), so a mixed sweep keeps just whichever
    // track the FIRST swept clip belongs to, same as clicking it alone
    // would. Every other row's clips all share one track already, so this
    // is a no-op there.
    const primaryTrack = hitClips[0].track ?? track;
    const hitIds = hitClips
      .filter((c) => (c.track ?? track) === primaryTrack)
      .map((c) => c.id);
    if (additive && selection?.track === primaryTrack) {
      const merged = new Set(selection.ids);
      for (const id of hitIds) merged.add(id);
      onSelect({ track: primaryTrack, ids: Array.from(merged) });
    } else {
      onSelect({ track: primaryTrack, ids: hitIds });
    }
  };

  return (
    <div
      ref={setRowRef}
      className={`relative flex border-b border-[color:var(--ed-border)] transition-colors duration-100 ${
        highlighted ? "bg-[color:var(--ed-accent-dim)]" : ""
      }`}
      style={{ height: rowHeight }}
    >
      <div className="sticky left-0 z-20 flex w-24 shrink-0 items-center gap-2 bg-[color:var(--ed-panel)] px-3 text-[11px] text-[color:var(--ed-ink-dim)]">
        <span className={`h-2 w-2 shrink-0 rounded-[3px] ${colorClass}`} />
        <span className="truncate">{label}</span>
      </div>
      <div
        ref={containerRef}
        className="relative flex-1"
        onPointerDown={beginMarquee}
        onPointerMove={onMarqueeMove}
        onPointerUp={endMarquee}
      >
        {insertMarkerSec !== null && (
          <div
            style={{ left: insertMarkerSec * pxPerSec }}
            className="pointer-events-none absolute top-0 bottom-0 z-40 w-0.5 -translate-x-1/2 bg-[color:var(--ed-accent)] shadow-[0_0_0_1px_var(--ed-panel),0_0_8px_var(--ed-accent)]"
          />
        )}
        {clips.map((c) => {
          const clipTrack = c.track ?? track;
          // Which clips this gesture actually moves: a drag on a clip that's
          // part of a live multi-selection carries the whole group (see
          // onCommitMove below), so every one of their edges is a candidate
          // to latch on — and none of them can be a target for it.
          const movingClips =
            onGroupMove &&
            selection?.track === clipTrack &&
            selection.ids.length > 1 &&
            selection.ids.includes(c.id)
              ? clips.filter(
                  (x) =>
                    (x.track ?? track) === clipTrack &&
                    selection.ids.includes(x.id),
                )
              : [c];
          const snap:
            | ((kind: "move" | "in" | "out", rawDeltaPx: number) => SnapResult)
            | undefined = resolveDragSnap
            ? (kind, rawDeltaPx) => {
                if (kind === "move" && !snapMove)
                  return { deltaPx: rawDeltaPx, guideSec: null };
                // A trim is always one clip's one edge, even when the clip
                // sits in a multi-selection — so only that clip drops out of
                // the target set; its selected siblings stay put and stay
                // snappable, which is how you line a trim up with them.
                const gesturing = kind === "move" ? movingClips : [c];
                return resolveDragSnap({
                  edgesSec:
                    kind === "move"
                      ? gesturing.flatMap((x) => [x.tlInSec, x.tlOutSec])
                      : kind === "in"
                        ? [c.tlInSec]
                        : [c.tlOutSec],
                  excludeKeys: gesturing.map(
                    (x) => `${x.track ?? track}:${x.id}`,
                  ),
                  rawDeltaPx,
                });
              }
            : undefined;
          const clipColorClass =
            c.track === "music"
              ? TRACK_COLOR.music
              : c.track === "sfx"
                ? TRACK_COLOR.sfx
                : c.track === "captions"
                  ? TRACK_COLOR.captions
                  : colorClass;
          return (
            <TimelineClip
              key={c.id}
              left={c.tlInSec * pxPerSec}
              width={(c.tlOutSec - c.tlInSec) * pxPerSec}
              top={(lanes.get(c.id) ?? 0) * LANE_HEIGHT}
              height={LANE_HEIGHT}
              label={c.label}
              sublabel={c.sublabel}
              thumbnailSrc={c.thumbnailSrc}
              waveformSrc={c.waveformSrc}
              waveformInSec={c.waveformInSec}
              waveformOutSec={c.waveformOutSec}
              colorClass={clipColorClass}
              selected={isSelected(selection, clipTrack, c.id)}
              locked={locked}
              trimEdges={trimEdges}
              pxPerSec={pxPerSec}
              onSelect={(additive) => {
                // A plain click landing on a clip that's already part of an
                // active multi-selection keeps the whole group selected —
                // otherwise the drag that (very plausibly) follows this same
                // pointerdown would collapse to just this one clip before it
                // could ever move the group together.
                const inExistingGroup =
                  !additive &&
                  selection?.track === clipTrack &&
                  selection.ids.length > 1 &&
                  selection.ids.includes(c.id);
                if (inExistingGroup) return;
                onSelect(toggleSelect(selection, clipTrack, c.id, additive));
              }}
              onDragMove={
                handlers.dragMove && movingClips.length === 1
                  ? (d, clientY) =>
                      handlers.dragMove!(c.id, d, clipTrack, clientY)
                  : undefined
              }
              onDragEnd={handlers.dragEnd}
              onCommitMove={
                handlers.move
                  ? (d, clientY) => {
                      // Dragging any one clip of an active multi-selection
                      // shifts the whole group by the same delta, in one
                      // atomic edit — otherwise it's just that one clip. A
                      // group drag never retracks (which of several clips'
                      // layers would clientY even apply to?), so it skips
                      // straight to the horizontal-only group shift.
                      if (
                        onGroupMove &&
                        selection?.track === clipTrack &&
                        selection.ids.length > 1 &&
                        selection.ids.includes(c.id)
                      ) {
                        onGroupMove(clipTrack as FloatTrack, selection.ids, d);
                      } else {
                        handlers.move!(c.id, d, clipTrack, clientY);
                      }
                    }
                  : undefined
              }
              onCommitTrim={
                handlers.trim
                  ? (edge, d) => handlers.trim!(c.id, edge, d, clipTrack)
                  : undefined
              }
              snap={snap}
              onSnapGuide={onSnapGuide}
            />
          );
        })}
        {marquee &&
          (() => {
            const x0 = Math.min(marquee.startX, marquee.curX);
            const x1 = Math.max(marquee.startX, marquee.curX);
            const y0 = Math.min(marquee.startY, marquee.curY);
            const y1 = Math.max(marquee.startY, marquee.curY);
            return (
              <div
                className="pointer-events-none absolute z-20 border border-[color:var(--ed-accent)] bg-[color:var(--ed-accent)]/15"
                style={{ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }}
              />
            );
          })()}
      </div>
    </div>
  );
}

/** What a section's layers are called: PiP video layers count up from the
 *  main reel ("Video 2", "Video 3"…) since they ARE video — a clip lifted
 *  off the main track lands on the next video layer, not on an "Overlay";
 *  everything else numbers from 1 within its own kind. */
const KIND_NOUN: Record<TrackKind, string> = {
  overlay: "Video",
  text: "Text",
  captions: "Captions",
  music: "Music",
  sfx: "SFX",
};

/** "Text 2" when a track carries no explicit label of its own (the common
 *  case — a label only exists once a user actually renames a layer, not
 *  yet wired up in the UI, or a format author sets one). */
const trackLabel = (kind: TrackKind, track: EdlTrack, index: number): string => {
  if (track.label) return track.label;
  const noun = KIND_NOUN[kind];
  // The main reel is "Video", so the first PiP layer is already "Video 2".
  const n = kind === "overlay" ? index + 2 : index + 1;
  return n === 1 ? noun : `${noun} ${n}`;
};

/** The dashed placeholder that appears at the bottom of a kind's section
 *  while a live drag is about to create a new layer there — the only
 *  "add layer" affordance the timeline has, and it exists only for as
 *  long as something is being held over it. Releasing turns it into a
 *  real row in exactly that spot; moving away makes it vanish. */
const GhostTrackRow: React.FC<{ kind: TrackKind; index: number }> = ({
  kind,
  index,
}) => {
  const n = kind === "overlay" ? index + 2 : index + 1;
  return (
    <div
      className="flex border-b border-[color:var(--ed-border)] bg-[color:var(--ed-accent-dim)]"
      style={{ height: GHOST_ROW_HEIGHT }}
    >
      <div className="sticky left-0 z-20 flex w-24 shrink-0 items-center gap-2 bg-[color:var(--ed-panel)] px-3 text-[11px] text-[color:var(--ed-accent)]">
        <span className="h-2 w-2 shrink-0 rounded-[3px] border border-dashed border-[color:var(--ed-accent)]" />
        <span className="truncate">
          {KIND_NOUN[kind]} {n}
        </span>
      </div>
      <div className="relative m-1 flex flex-1 items-center rounded-md border border-dashed border-[color:var(--ed-accent)]/60 px-2 text-[11px] text-[color:var(--ed-accent)]">
        New {KIND_NOUN[kind].toLowerCase()} layer
      </div>
    </div>
  );
};

/**
 * Everything on the timeline that does NOT depend on the playhead position:
 * the ruler and all the track rows (~126 clips at a typical job's size).
 * Split out and memoized so playback — which only moves the playhead, 30
 * times a second — doesn't re-render this whole subtree on every frame.
 */
const TimelineTracks = memo(function TimelineTracks({
  pxPerSec,
  majorTicks,
  minorTicks,
  useFrames,
  fps,
  videoClips,
  textGroups,
  overlayGroups,
  captionGroups,
  musicGroups,
  sfxGroups,
  transitionClips,
  selection,
  onSelect,
  onRulerPointerDown,
  onRulerPointerMove,
  onRulerPointerUp,
  resolveDragSnap,
  onSnapGuide,
  commitClipDrag,
  previewClipDrag,
  commitVideoTrim,
  commitTransitionMove,
  commitTransitionTrim,
  commitFloatTrim,
  commitGroupMove,
  registerRow,
  clearDropPreview,
  dropKey,
  dropInsertSec,
}: {
  pxPerSec: number;
  majorTicks: number[];
  minorTicks: number[];
  useFrames: boolean;
  fps: number;
  videoClips: ClipView[];
  textGroups: TrackGroup[];
  overlayGroups: TrackGroup[];
  captionGroups: TrackGroup[];
  musicGroups: TrackGroup[];
  sfxGroups: TrackGroup[];
  transitionClips: ClipView[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  onRulerPointerDown: (e: React.PointerEvent) => void;
  onRulerPointerMove: (e: React.PointerEvent) => void;
  onRulerPointerUp: () => void;
  resolveDragSnap: DragSnapResolver;
  onSnapGuide: (sec: number | null) => void;
  /** The one handler every draggable clip's release goes through — main
   *  reel and free-floating layers alike — see Timeline's own. */
  commitClipDrag: (
    track: SelectionTrack,
    clipId: string,
    deltaSec: number,
    clientY: number,
  ) => void;
  previewClipDrag: (
    track: SelectionTrack,
    clipId: string,
    deltaSec: number,
    clientY: number,
  ) => void;
  commitVideoTrim: (
    clipId: string,
    edge: "in" | "out",
    deltaSec: number,
  ) => void;
  commitTransitionMove: (afterClipId: string, deltaSec: number) => void;
  commitTransitionTrim: (
    afterClipId: string,
    edge: "in" | "out",
    deltaSec: number,
  ) => void;
  commitFloatTrim: (
    track: FloatTrack,
    clipId: string,
    edge: "in" | "out",
    deltaSec: number,
  ) => void;
  commitGroupMove: (track: FloatTrack, ids: string[], deltaSec: number) => void;
  registerRow: (key: string, el: HTMLDivElement | null) => void;
  clearDropPreview: () => void;
  /** Where the live drag (if any) is about to land — see dropTargetKey.
   *  Drives which row tints and which section grows a ghost row. */
  dropKey: string | null;
  /** The cut on the main reel a live drag is about to insert at, if the
   *  drag is headed there. */
  dropInsertSec: number | null;
}) {
  // TrackRow hands back (id, delta, track, y); the drag resolvers take the
  // track first — same four values, reordered once here.
  const clipHandlers = {
    move: (id: string, d: number, track: SelectionTrack, clientY: number) =>
      commitClipDrag(track, id, d, clientY),
    dragMove: (id: string, d: number, track: SelectionTrack, clientY: number) =>
      previewClipDrag(track, id, d, clientY),
    dragEnd: clearDropPreview,
  };
  /** One kind's whole section: one TrackRow per real layer, plus — only
   *  while a drag is about to create one — the ghost row it'll become.
   *  Colors/labels/handlers are identical across every layer of a kind;
   *  only which clips land in which row differs. `selectionTrack` is the
   *  EDL array these clips are addressed by (text and PiP layers both
   *  hold `overlay` clips). */
  const renderKindSection = (
    kind: TrackKind,
    selectionTrack: FloatTrack,
    groups: TrackGroup[],
    colorClass: string,
  ) => (
    <>
      {groups.map((g, i) => (
        <TrackRow
          key={g.track.id}
          label={trackLabel(kind, g.track, i)}
          clips={g.clips}
          colorClass={colorClass}
          handlers={{
            ...clipHandlers,
            trim: (id, edge, d, track) =>
              commitFloatTrim(track as FloatTrack, id, edge, d),
          }}
          track={selectionTrack}
          selection={selection}
          onSelect={onSelect}
          onGroupMove={commitGroupMove}
          pxPerSec={pxPerSec}
          resolveDragSnap={resolveDragSnap}
          onSnapGuide={onSnapGuide}
          registerRow={registerRow}
          rowKey={rowKeyFor(kind, g.track.id)}
          highlighted={dropKey === rowKeyFor(kind, g.track.id)}
        />
      ))}
      {dropKey === `${kind}:new` && (
        <GhostTrackRow kind={kind} index={groups.length} />
      )}
    </>
  );
  return (
    <>
      {/* Ruler — click to jump, drag to scrub continuously */}
      <div
        className="sticky top-0 z-20 flex h-6 cursor-text border-b border-[color:var(--ed-border)] bg-[color:var(--ed-panel)]"
        onPointerDown={onRulerPointerDown}
        onPointerMove={onRulerPointerMove}
        onPointerUp={onRulerPointerUp}
        onPointerCancel={onRulerPointerUp}
      >
        <div className="w-24 shrink-0" />
        <div className="relative flex-1">
          {minorTicks.map((t) => (
            <div
              key={`minor-${t}`}
              style={{ left: t * pxPerSec }}
              className="absolute bottom-0 h-1.5 border-l border-[color:var(--ed-border)]"
            />
          ))}
          {majorTicks.map((t) => (
            <div
              key={`major-${t}`}
              style={{ left: t * pxPerSec }}
              className="absolute top-0 h-full border-l border-[color:var(--ed-border-strong)] pl-1 font-mono text-[10px] whitespace-nowrap tabular-nums text-[color:var(--ed-ink-dim)]"
            >
              {formatTick(t, useFrames, fps)}
            </div>
          ))}
        </div>
      </div>

      {/* CapCut's vertical order, top to bottom: text and captions sit
          above the picture, picture-in-picture video layers above the
          main reel, the magnetic main reel itself, then audio underneath.
          A new layer of any kind always appears at the bottom of its own
          section (that's where its ghost row previews it, too), so
          "text goes above, audio goes below" holds no matter what gets
          dropped where. */}
      {renderKindSection("text", "overlay", textGroups, TRACK_COLOR.text)}
      {renderKindSection(
        "captions",
        "captions",
        captionGroups,
        TRACK_COLOR.captions,
      )}
      {renderKindSection("overlay", "overlay", overlayGroups, TRACK_COLOR.pip)}

      <TrackRow
        label="Video"
        clips={videoClips}
        colorClass={TRACK_COLOR.video}
        handlers={{ ...clipHandlers, trim: commitVideoTrim }}
        track="video"
        selection={selection}
        onSelect={onSelect}
        pxPerSec={pxPerSec}
        resolveDragSnap={resolveDragSnap}
        onSnapGuide={onSnapGuide}
        snapMove={false}
        registerRow={registerRow}
        rowKey={MAIN_ROW_KEY}
        highlighted={dropKey?.startsWith(`${MAIN_ROW_KEY}:`) ?? false}
        insertMarkerSec={dropInsertSec}
      />
      {transitionClips.length > 0 && (
        <TrackRow
          label="Transitions"
          clips={transitionClips}
          colorClass={TRACK_COLOR.transition}
          handlers={{
            move: (id, d) => commitTransitionMove(id, d),
            trim: (id, edge, d) => commitTransitionTrim(id, edge, d),
          }}
          track="transition"
          selection={selection}
          onSelect={onSelect}
          pxPerSec={pxPerSec}
          resolveDragSnap={resolveDragSnap}
          onSnapGuide={onSnapGuide}
          trimEdges={OUT_TRIM_EDGE_ONLY}
        />
      )}
      {/* Music and sfx each get their own section — a music bed's edges
          shouldn't have to fight a burst of short sfx clips (or vice
          versa) for lane space, and each can have several independent
          layers of its own. */}
      {renderKindSection("music", "music", musicGroups, TRACK_COLOR.music)}
      {renderKindSection("sfx", "sfx", sfxGroups, TRACK_COLOR.sfx)}
    </>
  );
});

/** Where a file dragged in from the desktop should land, as the media
 *  route understands it — computed here from the same drop resolver every
 *  other drop goes through, then carried up to Editor's uploadMedia. */
export type UploadPlacement = {
  trackId?: string;
  newTrack?: boolean;
  atIndex?: number;
};

export function Timeline({
  edl,
  selection,
  onSelect,
  currentTimeSec,
  onSeek,
  onOp,
  onUpload,
}: {
  edl: Edl;
  selection: Selection;
  onSelect: (s: Selection) => void;
  currentTimeSec: number;
  onSeek: (sec: number) => void;
  onOp: (op: TimelineOp) => void;
  /** A file dragged straight from the desktop onto the timeline — same
   *  upload path as the media panel's Import, with the drop's own time
   *  and layer instead of the playhead. */
  onUpload: (
    file: File,
    kind: MediaKind,
    atSec: number,
    placement: UploadPlacement,
  ) => void;
}) {
  const [pxPerSec, setPxPerSec] = useState(70);
  const [containerWidth, setContainerWidth] = useState(800);
  // Snapping: dragged clips and the scrubbed playhead latch onto nearby
  // boundaries (see snapping.ts and resolveDragSnap below), with the green
  // guide marking each hit. The main reel is the one place a whole-clip
  // drag never snaps: that track is always kept contiguous (see
  // recomputeVideoTrack in timelineOps.ts), so a drag there inserts at the
  // nearest cut rather than landing at a free time (see commitClipDrag) —
  // trimming a reel clip DOES set a real time, so that still snaps.
  //
  // Defaults to on, then re-read from localStorage after hydration (see the
  // effect below) — reading storage during render would desync the first
  // client render from the server's, same reason Editor.tsx loads its own
  // saved layout in an effect rather than a lazy initializer.
  const [snapEnabled, setSnapEnabled] = useState(true);
  // The second a live drag has latched onto, if any — one line drawn across
  // every track (see the guide's own comment at the bottom of the render),
  // not per-row, because the whole point is to show that two things on
  // DIFFERENT rows share an exact time.
  const [snapGuideSec, setSnapGuideSec] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScrollLeft = useRef<number | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SNAP_PREF_KEY);
      if (raw !== null) setSnapEnabled(raw === "true");
    } catch {
      // Best-effort — a blocked/full localStorage just means the toggle
      // starts from its default each session.
    }
  }, []);

  const isFirstSnapPersist = useRef(true);
  useEffect(() => {
    if (isFirstSnapPersist.current) {
      isFirstSnapPersist.current = false;
      return;
    }
    try {
      window.localStorage.setItem(SNAP_PREF_KEY, String(snapEnabled));
    } catch {
      // See above — persistence is a convenience, never a requirement.
    }
  }, [snapEnabled]);

  const toggleSnap = useCallback(() => {
    setSnapEnabled((v) => !v);
    // Whatever was latched on is no longer meaningful the instant the mode
    // changes, so don't leave its line hanging on screen.
    setSnapGuideSec(null);
  }, []);

  // S toggles snapping — the same key Premiere and Resolve use for it, and
  // it's a mode you flip mid-drag-session often enough that reaching for
  // the toolbar every time is the wrong ergonomics. Bare key (no modifier)
  // so it can't collide with the Cmd/Ctrl shortcuts Editor.tsx owns, and
  // ignored while typing, exactly like that handler does.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
      )
        return;
      if (e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      toggleSnap();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleSnap]);

  // "Full overview" = the whole video fits in the visible width with no
  // scrolling; "frame-level precision" = zoomed in enough to tell
  // individual frames apart. Both ends of the zoom range are derived from
  // the actual video, not arbitrary constants.
  const minPxPerSec = Math.max(
    2,
    (containerWidth - TRACK_LABEL_WIDTH) / Math.max(edl.durationSec, 0.1),
  );
  const maxPxPerSec = Math.max(
    minPxPerSec * 4,
    edl.fps * PX_PER_FRAME_AT_MAX_ZOOM,
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) =>
      setContainerWidth(entries[0].contentRect.width),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep pxPerSec valid as the fit-to-view bounds shift (panel resize,
  // duration change from an edit) — a no-op once already in range.
  useEffect(() => {
    setPxPerSec((v) => clamp(v, minPxPerSec, maxPxPerSec));
  }, [minPxPerSec, maxPxPerSec]);

  // Applied after the DOM has already re-rendered at the new pxPerSec, so
  // the browser clamps scrollLeft against the correct (new) content width
  // instead of the stale one — otherwise cursor-centered zoom jitters.
  useLayoutEffect(() => {
    if (pendingScrollLeft.current !== null && scrollRef.current) {
      scrollRef.current.scrollLeft = pendingScrollLeft.current;
      pendingScrollLeft.current = null;
    }
  }, [pxPerSec]);

  /**
   * Zoom always holds ONE point of the timeline fixed on screen. Changing
   * pxPerSec alone doesn't do that: scrollLeft is a pixel offset, so
   * leaving it alone pins the viewport's LEFT EDGE and everything you were
   * actually looking at slides out from under you as the scale grows.
   * Every zoom path below therefore re-derives scrollLeft from the second
   * it wants to keep put.
   */
  const zoomAnimation = useRef<number | null>(null);
  const cancelZoomAnimation = () => {
    if (zoomAnimation.current !== null) {
      cancelAnimationFrame(zoomAnimation.current);
      zoomAnimation.current = null;
    }
  };
  useEffect(() => cancelZoomAnimation, []);

  /** The scroll offset that puts `sec` at `anchorX` px from the scroll
   *  container's left edge, at scale `px`. */
  const scrollLeftFor = (sec: number, px: number, anchorX: number) =>
    Math.max(0, sec * px + TRACK_LABEL_WIDTH - anchorX);

  /** Which screen x a toolbar zoom should hold fixed. The playhead is the
   *  point of interest whenever it's actually visible — that's the frame
   *  being worked on — but pinning it when it's scrolled out of view (or
   *  hidden under the sticky label gutter) would drag the viewport off to
   *  somewhere the user isn't looking, so that case falls back to holding
   *  the middle of whatever IS on screen. */
  const toolbarAnchorX = () => {
    const el = scrollRef.current;
    if (!el) return 0;
    const playheadX =
      currentTimeSec * pxPerSec + TRACK_LABEL_WIDTH - el.scrollLeft;
    const visibleWidth = el.clientWidth;
    return playheadX >= TRACK_LABEL_WIDTH && playheadX <= visibleWidth
      ? playheadX
      : visibleWidth / 2;
  };

  /** Anchored zoom, applied at once — for the continuous gestures (wheel
   *  and slider drag), where the gesture itself is already supplying the
   *  gradual change and a tween could only lag behind the input. */
  const zoomImmediate = (next: number, anchorX: number) => {
    const el = scrollRef.current;
    if (!el) return;
    cancelZoomAnimation();
    const target = clamp(next, minPxPerSec, maxPxPerSec);
    const anchorSec = (anchorX + el.scrollLeft - TRACK_LABEL_WIDTH) / pxPerSec;
    pendingScrollLeft.current = scrollLeftFor(anchorSec, target, anchorX);
    setPxPerSec(target);
  };

  /** Anchored zoom, eased over ZOOM_ANIM_MS — for the discrete steps (the
   *  zoom buttons, fit), which otherwise land as a cut with nothing tying
   *  the before and after together. The anchored second is captured once,
   *  up front, so every frame re-projects from the same fixed point
   *  instead of re-deriving it from a scrollLeft the browser may have
   *  clamped at either end of the track. */
  const zoomAnimated = (next: number, anchorX: number) => {
    const el = scrollRef.current;
    if (!el) return;
    cancelZoomAnimation();
    const from = pxPerSec;
    const to = clamp(next, minPxPerSec, maxPxPerSec);
    if (Math.abs(to - from) < 0.01) return;
    const anchorSec = (anchorX + el.scrollLeft - TRACK_LABEL_WIDTH) / from;
    const startedAt = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - startedAt) / ZOOM_ANIM_MS);
      // easeOutCubic — most of the travel up front, settling into the
      // final scale rather than stopping dead on it.
      const value = from + (to - from) * (1 - Math.pow(1 - t, 3));
      pendingScrollLeft.current = scrollLeftFor(anchorSec, value, anchorX);
      setPxPerSec(value);
      zoomAnimation.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    zoomAnimation.current = requestAnimationFrame(step);
  };

  // Ctrl/Cmd+scroll (trackpad pinch maps to this too) zooms, centered on
  // the cursor — plain scroll still pans the timeline natively.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      // Anchored on the cursor: the pointer is over the timeline, so
      // whatever's under it is by definition the point of interest.
      zoomImmediate(
        pxPerSec * Math.exp(-e.deltaY * 0.0025),
        e.clientX - el.getBoundingClientRect().left,
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pxPerSec, minPxPerSec, maxPxPerSec]);

  const videoClips: ClipView[] = useMemo(
    () =>
      edl.video.map((v) => ({
        id: v.id,
        tlInSec: v.tlInSec,
        tlOutSec: v.tlOutSec,
        label: v.blockId,
        sublabel: v.muted ? "muted" : undefined,
        // Muted segments never play audio, so a waveform there would just
        // be misleading — skip it and let the "muted" sublabel speak for
        // itself.
        //
        // Routed through the same preview proxy the Player's own video
        // elements use (see EdlVideo.tsx's previewProxySrc), not the raw
        // asset directly — v.src often points at a 15-40MB 4K original,
        // and decoding a clip's FULL audio track for its waveform doesn't
        // need the original's video bitrate along for the ride. Every clip
        // renders its waveform on Timeline mount (not lazily), so this
        // was routinely tens of MB of unnecessary download up front.
        waveformSrc: v.muted ? undefined : previewProxySrc(edl.jobId, v.src),
        waveformInSec: v.srcInSec,
        waveformOutSec: v.srcOutSec,
        family: "video" as const,
      })),
    [edl.video, edl.jobId],
  );

  const overlayClips: ClipView[] = useMemo(
    () =>
      edl.overlays.map((o) => {
        const src = typeof o.params.src === "string" ? o.params.src : undefined;
        const text =
          typeof o.params.text === "string" ? o.params.text : undefined;
        const filename = src?.split("/").pop();
        return {
          id: o.id,
          tlInSec: o.tlInSec,
          tlOutSec: o.tlOutSec,
          // Text/name first (most recognizable at a glance); a bare
          // image/gif/video falls back to its filename. Either way the
          // component name rides along underneath for context.
          label: text ?? filename ?? o.component,
          sublabel: (text ?? filename) ? o.component : undefined,
          // Images and gifs both go through ImageOverlay — shown as an
          // actual filmstrip thumbnail instead of just a filename, so
          // they're recognizable, not just a same-colored box with text.
          thumbnailSrc:
            o.component === "ImageOverlay" && src ? `/${src}` : undefined,
          trackId: o.trackId,
          // A VideoOverlay is footage — it can be dropped back onto the
          // main reel; an image can only ever be a PiP layer; text only
          // ever a text layer.
          family:
            o.component === "VideoOverlay"
              ? ("video" as const)
              : (overlayTrackKind(o.component) as DragFamily),
        };
      }),
    [edl.overlays],
  );

  const sfxClips: ClipView[] = useMemo(
    () =>
      edl.sfx.map((s) => ({
        id: s.id,
        tlInSec: s.tlInSec,
        tlOutSec: s.tlInSec + (s.durationSec ?? edl.durationSec - s.tlInSec),
        label: s.src.split("/").pop() ?? s.src,
        sublabel: "sfx",
        trackId: s.trackId,
        family: "sfx" as const,
      })),
    [edl.sfx, edl.durationSec],
  );

  const transitionClips: ClipView[] = useMemo(
    () =>
      edl.transitions.map((t) => ({
        id: t.afterClipId,
        tlInSec: t.atSec,
        tlOutSec: t.atSec + t.durationSec,
        label: t.component,
        // Never dragged between rows — a transition lives on a cut.
        family: "video" as const,
      })),
    [edl.transitions],
  );

  const captionClips: ClipView[] = useMemo(
    () =>
      edl.captions.map((c) => ({
        id: c.id,
        tlInSec: c.tlInSec,
        tlOutSec: c.tlOutSec,
        label: c.words.map((w) => w.text).join(" "),
        sublabel: "caption",
        trackId: c.trackId,
        family: "captions" as const,
      })),
    [edl.captions],
  );

  const musicClips: ClipView[] = useMemo(
    () =>
      edl.music.map((m) => ({
        id: m.id,
        tlInSec: m.tlInSec,
        tlOutSec: m.tlInSec + (m.durationSec ?? edl.durationSec - m.tlInSec),
        label: m.src.split("/").pop() ?? "music",
        sublabel: "music",
        trackId: m.trackId,
        family: "music" as const,
      })),
    [edl.music, edl.durationSec],
  );

  // Sound effects and music beds each get their own row now (see
  // TimelineTracks), but snapping still wants one flat list of every
  // audio edge to latch onto regardless of which row it's drawn in — each
  // tagged with its real underlying track so a snap hit still routes back
  // to the correct EDL array.
  const audioClips: ClipView[] = useMemo(
    () => [
      ...musicClips.map((c) => ({ ...c, track: "music" as const })),
      ...sfxClips.map((c) => ({ ...c, track: "sfx" as const })),
    ],
    [musicClips, sfxClips],
  );

  // One TrackRow per real EdlTrack (layer) instead of one row per whole
  // kind — see TrackGroup's own doc comment. `edl.tracks` always has at
  // least an entry per kind that has any clips at all (normalizeAllTracks
  // guarantees this on every read/write — see timelineOps.ts), so a
  // format-authored job opened for the very first time already renders
  // one layer per kind, same as before this feature existed; a SECOND
  // layer only ever appears once a user (or an overlap) actually creates
  // one.
  // Text overlays and picture-in-picture overlays share `edl.overlays`
  // but live on strictly separate track kinds (see overlayTrackKind), so
  // each kind's rows are grouped from its own slice of the list.
  const textGroups = useMemo(
    () =>
      groupByTrack(
        edl.tracks,
        "text",
        overlayClips.filter((c) => c.family === "text"),
      ),
    [edl.tracks, overlayClips],
  );
  const overlayGroups = useMemo(
    () =>
      groupByTrack(
        edl.tracks,
        "overlay",
        overlayClips.filter((c) => c.family !== "text"),
      ),
    [edl.tracks, overlayClips],
  );
  const captionGroups = useMemo(
    () => groupByTrack(edl.tracks, "captions", captionClips),
    [edl.tracks, captionClips],
  );
  const musicGroups = useMemo(
    () => groupByTrack(edl.tracks, "music", musicClips),
    [edl.tracks, musicClips],
  );
  const sfxGroups = useMemo(
    () => groupByTrack(edl.tracks, "sfx", sfxClips),
    [edl.tracks, sfxClips],
  );

  // Every droppable row (the main reel and each per-layer row) registers
  // its live DOM element here, keyed "main" or `${kind}:${trackId}` —
  // populated by ref callbacks as rows mount/unmount, so this never goes
  // stale the way a once-measured, cached rect would after a scroll or a
  // layout change. A ref, not state, because updating it on every mount
  // must never itself trigger a re-render.
  const rowElsRef = useRef(new Map<string, HTMLDivElement>());
  const registerRow = useCallback((key: string, el: HTMLDivElement | null) => {
    if (el) rowElsRef.current.set(key, el);
    else rowElsRef.current.delete(key);
  }, []);

  /** Hit-tests a screen Y against every registered row, fresh
   *  (getBoundingClientRect, not a cached value). Null when the pointer is
   *  over no row at all — the ruler, or the blank space below the last
   *  track — which the drop resolver reads as "make a new layer". */
  const pickRowAt = useCallback((clientY: number): RowHit => {
    for (const [key, el] of rowElsRef.current) {
      const rect = el.getBoundingClientRect();
      if (clientY < rect.top || clientY >= rect.bottom) continue;
      if (key === MAIN_ROW_KEY) return { kind: "main" };
      const sep = key.indexOf(":");
      return {
        kind: key.slice(0, sep) as TrackKind,
        trackId: key.slice(sep + 1),
      };
    }
    return null;
  }, []);

  /** Timeline second under a screen X — the inverse of how every clip,
   *  tick and the playhead are positioned (time*pxPerSec, after the
   *  label gutter). */
  const secFromClientX = useCallback(
    (clientX: number): number => {
      const el = scrollRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left + el.scrollLeft - TRACK_LABEL_WIDTH;
      return Math.max(0, x / pxPerSec);
    },
    [pxPerSec],
  );

  /** Every clip currently on each free-floating layer, for the drop
   *  resolver's overlap check — rebuilt only when the clips do. */
  const clipsByTrack = useMemo(() => {
    const map = new Map<string, Interval[]>();
    for (const c of [...overlayClips, ...captionClips, ...musicClips, ...sfxClips]) {
      if (!c.trackId) continue;
      const list = map.get(c.trackId) ?? [];
      list.push({ id: c.id, tlInSec: c.tlInSec, tlOutSec: c.tlOutSec });
      map.set(c.trackId, list);
    }
    return map;
  }, [overlayClips, captionClips, musicClips, sfxClips]);
  const clipsOnTrack = useCallback(
    (trackId: string): Interval[] => clipsByTrack.get(trackId) ?? [],
    [clipsByTrack],
  );

  /** The one resolver behind every drop, internal and external alike. */
  const resolveDrop = useCallback(
    (payload: DragPayload, clientY: number, tlInSec: number): DropTarget =>
      resolveDropTarget({
        payload,
        row: pickRowAt(clientY),
        tlInSec,
        clipsOnTrack,
        mainClips: edl.video,
      }),
    [pickRowAt, clipsOnTrack, edl.video],
  );

  /** Live "where will this land?" feedback: the tinted row / ghost row /
   *  main-reel insertion marker TimelineTracks draws. Held as the target's
   *  stable key plus the one number the rows need, and only ever SET when
   *  the key changes — a pointer move that doesn't change the answer must
   *  not re-render every track row. */
  const [dropPreview, setDropPreview] = useState<{
    key: string;
    insertSec: number | null;
  } | null>(null);
  const clearDropPreview = useCallback(() => setDropPreview(null), []);
  const showDropPreview = useCallback(
    (target: DropTarget | null) => {
      const key = dropTargetKey(target);
      const insertSec =
        target?.kind === "main"
          ? (mainCuts(edl.video)[target.index] ?? null)
          : null;
      setDropPreview((prev) => {
        if (!key) return prev === null ? prev : null;
        if (prev && prev.key === key && prev.insertSec === insertSec)
          return prev;
        return { key, insertSec };
      });
    },
    [edl.video],
  );

  /** The dragged clip's own view, whichever array it lives in. */
  const findClipView = useCallback(
    (track: SelectionTrack, clipId: string): ClipView | undefined =>
      (track === "video"
        ? videoClips
        : track === "overlay"
          ? overlayClips
          : track === "sfx"
            ? sfxClips
            : track === "captions"
              ? captionClips
              : track === "music"
                ? musicClips
                : transitionClips
      ).find((c) => c.id === clipId),
    [
      videoClips,
      overlayClips,
      sfxClips,
      captionClips,
      musicClips,
      transitionClips,
    ],
  );

  /** For a main-reel clip being dragged, the insertion marker has to be
   *  computed against the reel WITHOUT that clip (it's the sequence the
   *  clip will be spliced back into) — so the preview for that one case
   *  re-derives cuts from the remaining clips rather than from edl.video. */
  const previewClipDrag = useCallback(
    (
      track: SelectionTrack,
      clipId: string,
      deltaSec: number,
      clientY: number,
    ) => {
      const view = findClipView(track, clipId);
      if (!view) return;
      const target = resolveDrop(
        {
          family: view.family,
          durationSec: view.tlOutSec - view.tlInSec,
          selfId: clipId,
        },
        clientY,
        view.tlInSec + deltaSec,
      );
      if (target.kind === "main" && track === "video") {
        const remaining = edl.video.filter((v) => v.id !== clipId);
        const insertSec = mainCuts(remaining)[target.index] ?? null;
        setDropPreview((prev) =>
          prev && prev.key === `main:${target.index}` && prev.insertSec === insertSec
            ? prev
            : { key: `main:${target.index}`, insertSec },
        );
        return;
      }
      showDropPreview(target);
    },
    [findClipView, resolveDrop, showDropPreview, edl.video],
  );

  /** Every clip drag's release lands here and turns into exactly one op:
   *
   *   main-reel clip  → main reel:   reorder (insert at the nearest cut)
   *                   → PiP layer:   videoToOverlay (lift off the reel)
   *   VideoOverlay    → main reel:   overlayToVideo (drop back onto it)
   *   any float clip  → own layer:   move
   *                   → other layer: moveToTrack (existing, or brand-new)
   *
   *  Nothing else is possible: the resolver never answers with a layer
   *  the clip's kind can't live on. */
  const commitClipDrag = useCallback(
    (
      track: SelectionTrack,
      clipId: string,
      deltaSec: number,
      clientY: number,
    ) => {
      setDropPreview(null);
      const view = findClipView(track, clipId);
      if (!view) return;
      const target = resolveDrop(
        {
          family: view.family,
          durationSec: view.tlOutSec - view.tlInSec,
          selfId: clipId,
        },
        clientY,
        view.tlInSec + deltaSec,
      );

      if (track === "video") {
        if (target.kind === "main") {
          // Insertion index is into the reel minus this clip, which is
          // exactly what applyReorder's toIndex means (it splices the
          // clip out first). Landing back in its own slot is a no-op.
          const from = edl.video.findIndex((v) => v.id === clipId);
          if (target.index !== from) {
            onOp({ type: "reorder", id: clipId, toIndex: target.index });
          }
          return;
        }
        // The reel can't be emptied — the last clip stays put.
        if (edl.video.length <= 1) return;
        onOp({
          type: "videoToOverlay",
          id: clipId,
          tlInSec: target.tlInSec,
          ...(target.newTrack
            ? { newTrack: true }
            : { trackId: target.trackId }),
        });
        return;
      }

      if (track === "transition") return;
      const floatTrack = track as FloatTrack;

      if (target.kind === "main") {
        onOp({ type: "overlayToVideo", id: clipId, atIndex: target.index });
        return;
      }
      if (!target.newTrack && target.trackId === view.trackId) {
        if (Math.abs(target.tlInSec - view.tlInSec) < 1e-6) return;
        onOp({
          type: "move",
          track: floatTrack,
          id: clipId,
          tlInSec: target.tlInSec,
        });
        return;
      }
      onOp({
        type: "moveToTrack",
        kind: floatTrack,
        id: clipId,
        // Omitted trackId = "make a fresh one" (see applyMoveToTrack).
        ...(target.newTrack ? {} : { trackId: target.trackId }),
        tlInSec: target.tlInSec,
      });
    },
    [findClipView, resolveDrop, edl.video, onOp],
  );

  // Read through a ref inside the resolver below rather than closed over:
  // the playhead is a snap target, but it also moves 30 times a second
  // during playback, and rebuilding the resolver on every frame would
  // re-render every track row (exactly what TimelineTracks' memo exists to
  // prevent).
  const currentTimeRef = useRef(currentTimeSec);
  currentTimeRef.current = currentTimeSec;

  /** Every fixed point a dragged edge can latch onto: the boundaries of
   *  every clip on every track (cross-track is the whole point — an overlay
   *  ending exactly on a cut), plus the start and end of the video. The
   *  playhead is appended at call time from the ref above. */
  const snapTargets: SnapTarget[] = useMemo(
    () => [
      { sec: 0, key: "timeline:start" },
      { sec: edl.durationSec, key: "timeline:end" },
      ...clipEdgeTargets(videoClips, "video"),
      ...clipEdgeTargets(overlayClips, "overlay"),
      ...clipEdgeTargets(audioClips, "sfx"),
      ...clipEdgeTargets(captionClips, "captions"),
      ...clipEdgeTargets(transitionClips, "transition"),
    ],
    [
      edl.durationSec,
      videoClips,
      overlayClips,
      audioClips,
      captionClips,
      transitionClips,
    ],
  );

  const resolveDragSnap = useCallback(
    ({
      edgesSec,
      excludeKeys,
      rawDeltaPx,
    }: {
      edgesSec: number[];
      excludeKeys: string[];
      rawDeltaPx: number;
    }) => {
      if (!snapEnabled) return { deltaPx: rawDeltaPx, guideSec: null };
      return resolveSnap({
        targets: [
          ...snapTargets,
          { sec: currentTimeRef.current, key: "playhead" },
        ],
        edgesSec,
        excludeKeys,
        rawDeltaPx,
        pxPerSec,
      });
    },
    [snapEnabled, snapTargets, pxPerSec],
  );

  const contentWidth = Math.max(600, (edl.durationSec + 3) * pxPerSec);

  const majorLadder = useMemo(() => buildMajorLadder(edl.fps), [edl.fps]);
  const { majorSec, minorSec, useFrames } = chooseTickScale(
    pxPerSec,
    edl.fps,
    majorLadder,
  );

  const majorTicks = useMemo(() => {
    const count = Math.ceil(edl.durationSec / majorSec) + 4;
    return Array.from({ length: count }, (_, i) => i * majorSec);
  }, [edl.durationSec, majorSec]);

  const minorTicks = useMemo(() => {
    if (minorSec <= 0) return [];
    const offsets: number[] = [];
    for (let t = minorSec; t < majorSec - 1e-9; t += minorSec) offsets.push(t);
    return majorTicks.flatMap((m) => offsets.map((o) => m + o));
  }, [majorTicks, majorSec, minorSec]);

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Ticks/clips/playhead are all positioned at time*pxPerSec +
      // TRACK_LABEL_WIDTH (seconds=0 starts after the label gutter, not at
      // the container's edge) — this has to subtract the same offset or
      // the playhead lands a constant TRACK_LABEL_WIDTH px ahead of the
      // cursor.
      const x = clientX - rect.left + el.scrollLeft - TRACK_LABEL_WIDTH;
      const rawSec = Math.max(0, x / pxPerSec);
      // Scrubbing latches onto clip boundaries too — parking the playhead
      // exactly on a cut is what "split here" and "trim to here" are aimed
      // at, and eyeballing it to the pixel otherwise gets you a frame off.
      if (!snapEnabled) {
        onSeek(rawSec);
        return;
      }
      const { sec, guideSec } = snapPoint({
        targets: snapTargets,
        sec: rawSec,
        pxPerSec,
      });
      setSnapGuideSec(guideSec);
      onSeek(sec);
    },
    [onSeek, pxPerSec, snapEnabled, snapTargets],
  );

  const onRulerPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      seekFromClientX(e.clientX);
    },
    [seekFromClientX],
  );
  const onRulerPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (e.buttons !== 1) return;
      seekFromClientX(e.clientX);
    },
    [seekFromClientX],
  );
  const onRulerPointerUp = useCallback(() => setSnapGuideSec(null), []);

  const commitVideoTrim = useCallback(
    (clipId: string, edge: "in" | "out", deltaSec: number) => {
      const clip = edl.video.find((v) => v.id === clipId);
      if (!clip) return;
      // A drag can overshoot past the timeline's own start (a fast pointer
      // move easily travels further than the clip has room for) — clamped
      // to 0 rather than sent through and rejected by the server's own
      // tlSec >= 0 check, same as the drop resolver already does for a move.
      const tlSec = Math.max(
        0,
        (edge === "in" ? clip.tlInSec : clip.tlOutSec) + deltaSec,
      );
      onOp({ type: "trimEdge", track: "video", id: clipId, edge, tlSec });
    },
    [edl.video, onOp],
  );

  // A transition can only ever sit at "the cut after some clip" — there's
  // no such thing as a transition floating between cuts. So dragging one
  // snaps to whichever clip boundary (excluding the last clip, which has
  // no next clip to blend into) ends up closest to the drop point.
  const commitTransitionMove = useCallback(
    (afterClipId: string, deltaSec: number) => {
      const t = edl.transitions.find((tr) => tr.afterClipId === afterClipId);
      if (!t) return;
      const targetSec = t.atSec + deltaSec;
      let bestId = afterClipId;
      let bestDist = Infinity;
      for (let i = 0; i < edl.video.length - 1; i++) {
        const dist = Math.abs(edl.video[i].tlOutSec - targetSec);
        if (dist < bestDist) {
          bestDist = dist;
          bestId = edl.video[i].id;
        }
      }
      if (bestId !== afterClipId)
        onOp({ type: "moveTransition", fromId: afterClipId, toId: bestId });
    },
    [edl.transitions, edl.video, onOp],
  );

  // The transition's leading edge is pinned to the cut it follows (atSec is
  // recomputed from the preceding clip's tlOutSec after every video-track
  // edit — see timelineOps.ts), so only its trailing edge is draggable:
  // that's the transition's duration, how far it plays into the next clip.
  const commitTransitionTrim = useCallback(
    (afterClipId: string, edge: "in" | "out", deltaSec: number) => {
      if (edge === "in") return;
      const t = edl.transitions.find((tr) => tr.afterClipId === afterClipId);
      if (!t) return;
      onOp({
        type: "setProp",
        track: "transition",
        id: afterClipId,
        patch: { durationSec: Math.max(t.durationSec + deltaSec, 0.05) },
      });
    },
    [edl.transitions, onOp],
  );

  const commitFloatTrim = useCallback(
    (
      track: FloatTrack,
      clipId: string,
      edge: "in" | "out",
      deltaSec: number,
    ) => {
      const view =
        track === "overlay"
          ? overlayClips.find((c) => c.id === clipId)
          : track === "sfx"
            ? sfxClips.find((c) => c.id === clipId)
            : track === "captions"
              ? captionClips.find((c) => c.id === clipId)
              : musicClips.find((c) => c.id === clipId);
      if (!view) return;
      const tlSec = Math.max(
        0,
        (edge === "in" ? view.tlInSec : view.tlOutSec) + deltaSec,
      );
      onOp({ type: "trimEdge", track, id: clipId, edge, tlSec });
    },
    [overlayClips, sfxClips, captionClips, musicClips, onOp],
  );

  // Multi-select group-drag: one atomic edit shifts every selected clip on
  // a free-floating track by the same delta (video is excluded — see
  // TrackRow/moveMany).
  const commitGroupMove = useCallback(
    (track: FloatTrack, ids: string[], deltaSec: number) => {
      onOp({ type: "moveMany", track, ids, deltaSec });
    },
    [onOp],
  );

  // ---- External drops: library cards, desktop files, "Add text" ----
  //
  // HTML5 drag-and-drop (as opposed to the pointer-event drags clips
  // already on the timeline use) — the same resolver decides where the
  // asset lands, and a drop turns into an ordinary add* op with the
  // resolver's placement attached, or an upload carrying it.

  /** What a drop target means to an add* op or the media route. */
  const placementFor = (t: DropTarget): UploadPlacement =>
    t.kind === "main"
      ? { atIndex: t.index }
      : t.newTrack
        ? { newTrack: true }
        : { trackId: t.trackId };

  /** Audio is one type to a user ("drop a sound here"), even though the
   *  EDL keeps music beds and one-shot effects in separate arrays — so an
   *  audio asset arriving from OUTSIDE the timeline takes on whichever
   *  audio kind the row under it is. (A clip already on the timeline
   *  keeps its own kind: there's no music↔sfx conversion op, and it'd be
   *  surprising for a bed to turn into an effect by being nudged.) */
  const adoptAudioRow = (family: DragFamily, row: RowHit): DragFamily =>
    (family === "music" || family === "sfx") &&
    (row?.kind === "music" || row?.kind === "sfx")
      ? row.kind
      : family;

  const onExternalDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    const info = dragFamilyFromTransfer(e.dataTransfer);
    if (!info) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const row = pickRowAt(e.clientY);
    showDropPreview(
      resolveDropTarget({
        payload: {
          family: adoptAudioRow(info.family, row),
          durationSec: info.durationSec,
        },
        row,
        tlInSec: secFromClientX(e.clientX),
        clipsOnTrack,
        mainClips: edl.video,
      }),
    );
  };

  const onExternalDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // dragleave fires for every child boundary crossed; only a genuine
    // exit from the whole scroll area clears the preview.
    const to = e.relatedTarget as Node | null;
    if (to && e.currentTarget.contains(to)) return;
    setDropPreview(null);
  };

  /** A library card becomes a NEW instance of its asset at the drop. */
  const assetDropOp = (asset: AssetDragPayload, target: DropTarget): TimelineOp => {
    // Only footage can land on the main reel; the resolver never sends
    // anything else there, but the types don't know that.
    const floatPlacement =
      target.kind === "main" ? { newTrack: true } : placementFor(target);
    switch (asset.kind) {
      case "video":
        if (target.kind === "main") {
          return {
            type: "addVideo",
            src: asset.src,
            durationSec: asset.durationSec,
            srcInSec: asset.srcInSec,
            srcDurationSec: asset.srcDurationSec,
            atIndex: target.index,
          };
        }
        return {
          type: "addOverlay",
          component: "VideoOverlay",
          src: asset.src,
          srcInSec: asset.srcInSec,
          srcDurationSec: asset.srcDurationSec,
          tlInSec: target.tlInSec,
          tlOutSec: target.tlInSec + asset.durationSec,
          ...PIP_DEFAULT_BOX,
          ...floatPlacement,
        };
      case "image":
        return {
          type: "addOverlay",
          component: "ImageOverlay",
          src: asset.src,
          tlInSec: target.tlInSec,
          tlOutSec: target.tlInSec + asset.durationSec,
          ...asset.box,
          ...floatPlacement,
        };
      case "music":
        return {
          type: "addMusic",
          src: asset.src,
          tlInSec: target.tlInSec,
          durationSec: asset.durationSec,
          ...floatPlacement,
        };
      case "sfx":
        return {
          type: "addSfx",
          src: asset.src,
          tlInSec: target.tlInSec,
          durationSec: asset.durationSec,
          ...floatPlacement,
        };
    }
  };

  const onExternalDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const dt = e.dataTransfer;
    if (!dragFamilyFromTransfer(dt)) return;
    e.preventDefault();
    setDropPreview(null);
    const tlInSec = secFromClientX(e.clientX);
    const row = pickRowAt(e.clientY);
    const resolve = (family: DragFamily, durationSec: number) =>
      resolveDropTarget({
        payload: { family: adoptAudioRow(family, row), durationSec },
        row,
        tlInSec,
        clipsOnTrack,
        mainClips: edl.video,
      });

    if (dt.types.includes(TEXT_OVERLAY_DRAG_TYPE)) {
      const target = resolve("text", DEFAULT_STILL_SEC);
      onOp(
        buildAddTextOverlayOp(
          target.tlInSec,
          undefined,
          target.kind === "main" ? { newTrack: true } : placementFor(target),
        ),
      );
      return;
    }

    const asset = readAssetDragData(dt);
    if (asset) {
      const family: DragFamily =
        asset.kind === "video"
          ? "video"
          : asset.kind === "image"
            ? "overlay"
            : asset.kind;
      const target = resolve(family, asset.durationSec ?? 0);
      // The row may have re-typed a music card as sfx (or vice versa).
      const resolved =
        (family === "music" || family === "sfx") &&
        (target.kind === "music" || target.kind === "sfx") &&
        target.kind !== asset.kind
          ? { ...asset, kind: target.kind }
          : asset;
      onOp(assetDropOp(resolved, target));
      return;
    }

    const file = dt.files?.[0];
    if (!file) return;
    const family = adoptAudioRow(fileFamily(file.type), row);
    const target = resolve(family, 0);
    const kind: MediaKind =
      family === "video"
        ? target.kind === "main"
          ? "video"
          : "overlayVideo"
        : family === "overlay"
          ? "overlayImage"
          : family === "sfx"
            ? "sfx"
            : "music";
    onUpload(file, kind, target.tlInSec, placementFor(target));
  };

  // Toolbar split/delete act on whatever's currently selected — a shortcut
  // for the same actions available per-clip in the Inspector. Only the
  // four real clip tracks support split (transitions/music have no
  // meaningful "cut in two").
  const isSplittableTrack = (
    t: SelectionTrack,
  ): t is "video" | "overlay" | "sfx" | "captions" =>
    t === "video" || t === "overlay" || t === "sfx" || t === "captions";

  // Delete is broader than split — transitions and music can be removed
  // outright even though they can't be split.
  const isDeletableTrack = (
    t: SelectionTrack,
  ): t is "video" | "overlay" | "sfx" | "captions" | "transition" | "music" =>
    isSplittableTrack(t) || t === "transition" || t === "music";

  // Split only ever acts on exactly one clip (no "split all" bulk action —
  // where the playhead falls inside several selected clips at once isn't a
  // single well-defined cut), so this only looks up the first id.
  const selectedClipView: ClipView | undefined =
    selection && selection.ids.length === 1
      ? selection.track === "video"
        ? videoClips.find((c) => c.id === selection.ids[0])
        : selection.track === "overlay"
          ? overlayClips.find((c) => c.id === selection.ids[0])
          : selection.track === "sfx"
            ? sfxClips.find((c) => c.id === selection.ids[0])
            : selection.track === "captions"
              ? captionClips.find((c) => c.id === selection.ids[0])
              : undefined
      : undefined;

  const canSplitSelection =
    !!selection &&
    selection.ids.length === 1 &&
    isSplittableTrack(selection.track) &&
    !!selectedClipView &&
    currentTimeSec > selectedClipView.tlInSec + 0.1 &&
    currentTimeSec < selectedClipView.tlOutSec - 0.1;

  const canDeleteSelection =
    !!selection &&
    isDeletableTrack(selection.track) &&
    !(
      selection.track === "video" &&
      edl.video.length - selection.ids.length <= 0
    );

  const splitSelection = () => {
    if (
      !selection ||
      selection.ids.length !== 1 ||
      !isSplittableTrack(selection.track)
    )
      return;
    onOp({
      type: "split",
      track: selection.track,
      id: selection.ids[0],
      atSec: currentTimeSec,
    });
  };

  const deleteSelection = () => {
    if (!selection || !isDeletableTrack(selection.track)) return;
    onOp({ type: "deleteMany", track: selection.track, ids: selection.ids });
  };

  const toolbarBtnClass =
    "flex h-7 w-7 items-center justify-center rounded-lg text-[color:var(--ed-ink-dim)] transition-colors hover:bg-[color:var(--ed-raised)] hover:text-[color:var(--ed-ink)] disabled:pointer-events-none disabled:opacity-30";

  return (
    <div className="flex h-full flex-col bg-[color:var(--ed-panel)]">
      <div className="flex items-center justify-between border-b border-[color:var(--ed-border)] px-2.5 py-1.5">
        <div className="flex items-center gap-1">
          {selection && selection.ids.length > 1 && (
            <span className="mr-1 text-[11px] text-[color:var(--ed-ink-dim)]">
              {selection.ids.length} selected
            </span>
          )}
          <button
            onClick={splitSelection}
            disabled={!canSplitSelection}
            title="Split at playhead"
            className={toolbarBtnClass}
          >
            <ScissorsIcon className="h-4 w-4" />
          </button>
          <button
            onClick={deleteSelection}
            disabled={!canDeleteSelection}
            title="Delete selected clip(s)"
            className={toolbarBtnClass}
          >
            <TrashIcon className="h-4 w-4" />
          </button>
          <span className="mx-1 h-4 w-px bg-[color:var(--ed-border-strong)]" />
          <button
            onClick={toggleSnap}
            role="switch"
            aria-checked={snapEnabled}
            aria-label="Snapping"
            title={
              snapEnabled
                ? "Snapping ON (S) — dragged clips and the playhead lock onto nearby edges, and a green guide marks the alignment"
                : "Snapping OFF (S) — clips move freely to wherever you drop them"
            }
            className={`flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium transition-colors ${
              snapEnabled
                ? "bg-[color:var(--ed-accent-dim)] text-[color:var(--ed-accent)] ring-1 ring-[color:var(--ed-accent)]/40"
                : "text-[color:var(--ed-ink-dim)] hover:bg-[color:var(--ed-raised)] hover:text-[color:var(--ed-ink)]"
            }`}
          >
            <MagnetIcon className="h-4 w-4" />
            Snap
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => zoomAnimated(minPxPerSec, toolbarAnchorX())}
            title="Fit whole video to view"
            className={toolbarBtnClass}
          >
            <FitIcon className="h-4 w-4" />
          </button>
          <button
            onClick={() => zoomAnimated(pxPerSec / 1.4, toolbarAnchorX())}
            title="Zoom out"
            className={toolbarBtnClass}
          >
            <ZoomOutIcon className="h-4 w-4" />
          </button>
          <input
            type="range"
            min={minPxPerSec}
            max={maxPxPerSec}
            step={(maxPxPerSec - minPxPerSec) / 200 || 1}
            value={pxPerSec}
            onChange={(e) =>
              zoomImmediate(Number(e.target.value), toolbarAnchorX())
            }
            className="w-24 accent-[color:var(--ed-accent)]"
            title="Zoom"
          />
          <button
            onClick={() => zoomAnimated(pxPerSec * 1.4, toolbarAnchorX())}
            title="Zoom in"
            className={toolbarBtnClass}
          >
            <ZoomInIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="relative flex-1 overflow-x-auto overflow-y-auto"
        onClick={() => onSelect(null)}
        onDragOver={onExternalDragOver}
        onDragLeave={onExternalDragLeave}
        onDrop={onExternalDrop}
      >
        {/* min-h-full so the blank space below the last track is part of
            the drop surface — dropping there is how a new layer gets made
            from nothing, so it has to actually be there to drop onto. */}
        <div style={{ width: contentWidth }} className="relative min-h-full">
          <TimelineTracks
            pxPerSec={pxPerSec}
            majorTicks={majorTicks}
            minorTicks={minorTicks}
            useFrames={useFrames}
            fps={edl.fps}
            videoClips={videoClips}
            textGroups={textGroups}
            overlayGroups={overlayGroups}
            captionGroups={captionGroups}
            musicGroups={musicGroups}
            sfxGroups={sfxGroups}
            transitionClips={transitionClips}
            selection={selection}
            onSelect={onSelect}
            onRulerPointerDown={onRulerPointerDown}
            onRulerPointerMove={onRulerPointerMove}
            onRulerPointerUp={onRulerPointerUp}
            resolveDragSnap={resolveDragSnap}
            onSnapGuide={setSnapGuideSec}
            commitClipDrag={commitClipDrag}
            previewClipDrag={previewClipDrag}
            commitVideoTrim={commitVideoTrim}
            commitTransitionMove={commitTransitionMove}
            commitTransitionTrim={commitTransitionTrim}
            commitFloatTrim={commitFloatTrim}
            commitGroupMove={commitGroupMove}
            registerRow={registerRow}
            clearDropPreview={clearDropPreview}
            dropKey={dropPreview?.key ?? null}
            dropInsertSec={dropPreview?.insertSec ?? null}
          />

          {/* Playhead — the line is decorative only (so it doesn't block
              clicks on clips it passes over); the handle is the real,
              draggable control. Kept outside TimelineTracks since this is
              the one piece that legitimately updates every frame during
              playback. */}
          <div
            style={{ left: currentTimeSec * pxPerSec + TRACK_LABEL_WIDTH }}
            className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-[color:var(--ed-accent)]"
          >
            <div
              onPointerDown={(e) => {
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
                seekFromClientX(e.clientX);
              }}
              onPointerMove={(e) => {
                if (e.buttons !== 1) return;
                seekFromClientX(e.clientX);
              }}
              onPointerUp={onRulerPointerUp}
              onPointerCancel={onRulerPointerUp}
              className="pointer-events-auto absolute -top-0.5 -left-2.5 h-5 w-5 cursor-ew-resize rounded-full bg-[color:var(--ed-accent)] ring-2 ring-[color:var(--ed-panel)]"
            />
          </div>

          {/* Snap guide — the proof. It only exists while something is
              latched on, and it spans every track precisely because the
              claim it makes is cross-track: the edge being dragged and
              whatever it locked onto are at the SAME time, to the
              millisecond. Green so it can't be confused with the playhead
              (violet, always present) sitting a pixel away from it, and
              above everything since it's the one thing that has to stay
              readable over a clip it crosses. */}
          {snapGuideSec !== null && (
            <div
              style={{ left: snapGuideSec * pxPerSec + TRACK_LABEL_WIDTH }}
              className="pointer-events-none absolute top-0 bottom-0 z-40 w-px bg-[color:var(--ed-snap)] shadow-[0_0_0_0.5px_var(--ed-snap-glow),0_0_8px_var(--ed-snap-glow)]"
            />
          )}
        </div>
      </div>
    </div>
  );
}

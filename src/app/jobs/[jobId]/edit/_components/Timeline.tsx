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
import type { TimelineOp } from "@backend/pipeline/timelineOps";
import { previewProxySrc } from "@backend/remotion/previewSrc";
import { TimelineClip } from "./TimelineClip";
import { assignLanes, laneCount } from "./lanes";
import {
  isSelected,
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

/** One hue family (indigo → violet → purple) so tracks read as a system;
 *  transitions get the one intentional exception (amber) since they're a
 *  different kind of thing — an effect marker, not a content clip. */
const TRACK_COLOR = {
  video: "bg-indigo-500/85",
  transition: "bg-amber-500/75",
  // Overlays and captions each get their own row now (Overlays/Captions
  // below), but keep the violet family so they still read as "both text"
  // — captions get the darker sibling shade so a caption chip still looks
  // distinct from an overlay bar, same as sfx/music stay distinguishable
  // from each other despite both being audio.
  text: "bg-violet-500/80",
  sfx: "bg-purple-400/75",
  captions: "bg-violet-700/85",
  music: "bg-indigo-900/85",
} as const;

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
/** Free-move video reordering: fraction of the dragged clip's own width
 *  that's credited toward crossing a neighbor before the cursor gets
 *  there, so a modest drag reorders instead of snapping back to the same
 *  slot. See commitVideoMove. */
const FREE_MOVE_BIAS = 0.65;
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
};

type FloatTrack = "overlay" | "sfx" | "captions" | "music";

/** One row's worth of clips, already filtered to one specific EdlTrack —
 *  what TrackRow actually renders now, instead of every clip of a whole
 *  kind sharing one auto-lane-packed row. */
type TrackGroup = { track: EdlTrack; clips: ClipView[] };

/** Splits one kind's flat clip list into one group per EdlTrack, in the
 *  SAME order `edl.tracks` lists them (so a track a user just created via
 *  "+" appears where they'd expect, and reordering `edl.tracks` — not
 *  wired up yet, but the data already supports it — would reorder rows
 *  for free). A clip whose trackId doesn't match any given track (should
 *  only happen for one render frame between an edit and the server's
 *  normalized response) is silently dropped rather than crashing — the
 *  authoritative response replaces it immediately after. */
const groupByTrack = (
  tracks: EdlTrack[],
  kind: FloatTrack,
  clips: ClipView[],
): TrackGroup[] =>
  tracks
    .filter((t) => t.kind === kind)
    .map((track) => ({
      track,
      clips: clips.filter((c) => c.trackId === track.id),
    }));

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
  onRemove,
}: {
  label: string;
  clips: ClipView[];
  colorClass: string;
  handlers: {
    // The track argument is only meaningful for a row that mixes clips
    // from more than one EDL array (the merged Audio row) — it's each
    // clip's own resolved track (c.track ?? the row's fixed `track` prop),
    // so a single-track row's handlers can just ignore the third arg,
    // same as they always have. `clientY` is the drag's final screen
    // position, passed straight through from TimelineClip — only "move"
    // needs it (a candidate cross-layer retrack), never "trim".
    move?: (
      id: string,
      deltaSec: number,
      track: SelectionTrack,
      clientY: number,
    ) => void;
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
   *  reorders it among its neighbours (see commitVideoMove), so latching its
   *  edge onto a boundary would promise a landing spot the commit doesn't
   *  honour. Trimming a video clip DOES set a real time, so that still
   *  snaps. */
  snapMove?: boolean;
  /** Registers this row's own screen bounds under `rowKey` (undoing the
   *  registration on unmount) so a clip dropped elsewhere on the timeline
   *  can be hit-tested against every OTHER row's real position — see
   *  Timeline's own pickTrackAt. Omitted for rows with no track concept
   *  (Video/Transitions) and for a kind's own "+ new track" strip, which
   *  registers itself directly instead of going through TrackRow. */
  registerRow?: (key: string, el: HTMLDivElement | null) => void;
  rowKey?: string;
  /** Present only for an EMPTY layer of a kind that has more than one —
   *  removing the last/only layer of a kind would just leave nothing for
   *  the next add* op to attach to until normalizeAllTracks reinvents one,
   *  which is harmless but a confusing thing for a button to do, so
   *  Timeline never offers this except when there's a genuine layer to
   *  spare. */
  onRemove?: () => void;
}) {
  const lanes = useMemo(() => assignLanes(clips), [clips]);
  const rowHeight = laneCount(lanes) * LANE_HEIGHT;
  const containerRef = useRef<HTMLDivElement>(null);
  // Memoized on rowKey/registerRow (both stable across a row's own
  // lifetime) so React doesn't see a new ref callback identity every
  // render — an unstable one would detach/reattach (null, then the
  // element again) on every re-render instead of only on real mount/
  // unmount, needlessly churning Timeline's own row registry.
  const setContainerRef = useCallback(
    (el: HTMLDivElement | null) => {
      containerRef.current = el;
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
      className="relative flex border-b border-[color:var(--ed-border)]"
      style={{ height: rowHeight }}
    >
      <div className="sticky left-0 z-20 flex w-24 shrink-0 items-center gap-2 bg-[color:var(--ed-panel)] px-3 text-[11px] text-[color:var(--ed-ink-dim)]">
        <span className={`h-2 w-2 shrink-0 rounded-[3px] ${colorClass}`} />
        <span className="truncate">{label}</span>
        {onRemove && (
          <button
            onClick={onRemove}
            title="Remove this empty layer"
            className="ml-auto shrink-0 text-[color:var(--ed-ink-dim)] hover:text-[color:var(--ed-ink)]"
          >
            ×
          </button>
        )}
      </div>
      <div
        ref={setContainerRef}
        className="relative flex-1"
        onPointerDown={beginMarquee}
        onPointerMove={onMarqueeMove}
        onPointerUp={endMarquee}
      >
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

/** The persistent "+" strip at the bottom of one kind's group of layers —
 *  clicking it always creates a new empty track; it's ALSO a valid drop
 *  target for a clip dragged down past its own kind's last row (registered
 *  under the same `${kind}:new` key pickTrackAt in Timeline looks for), so
 *  "drag below the last layer" and "click +" both funnel into one place a
 *  brand-new layer can come from. */
const AddTrackRow: React.FC<{
  kind: FloatTrack;
  onAdd: (kind: FloatTrack) => void;
  registerRow?: (key: string, el: HTMLDivElement | null) => void;
}> = ({ kind, onAdd, registerRow }) => {
  const setRef = useCallback(
    (el: HTMLDivElement | null) => registerRow?.(`${kind}:new`, el),
    [kind, registerRow],
  );
  return (
    <div
      ref={setRef}
      className="flex border-b border-[color:var(--ed-border)]"
      style={{ height: 22 }}
    >
      <div className="sticky left-0 z-20 w-24 shrink-0 bg-[color:var(--ed-panel)]" />
      <button
        onClick={() => onAdd(kind)}
        title={`Add a new ${kind} layer — or drag a clip down here`}
        className="flex flex-1 items-center px-2 text-[11px] text-[color:var(--ed-ink-dim)] hover:bg-[color:var(--ed-raised)] hover:text-[color:var(--ed-ink)]"
      >
        + Add layer
      </button>
    </div>
  );
};

/** "Overlay 2" when a track carries no explicit label of its own (the
 *  common case — a label only exists once a user actually renames a
 *  layer, not yet wired up in the UI, or a format author sets one). */
const trackLabel = (
  kind: FloatTrack,
  track: EdlTrack,
  index: number,
): string => {
  if (track.label) return track.label;
  const noun =
    kind === "overlay"
      ? "Overlay"
      : kind === "captions"
        ? "Captions"
        : kind === "music"
          ? "Music"
          : "SFX";
  return index === 0 ? noun : `${noun} ${index + 1}`;
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
  commitVideoMove,
  commitVideoTrim,
  commitTransitionMove,
  commitTransitionTrim,
  commitFloatMove,
  commitFloatTrim,
  commitGroupMove,
  registerRow,
  onAddTrack,
  onRemoveTrack,
}: {
  pxPerSec: number;
  majorTicks: number[];
  minorTicks: number[];
  useFrames: boolean;
  fps: number;
  videoClips: ClipView[];
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
  commitVideoMove: (clipId: string, deltaSec: number) => void;
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
  commitFloatMove: (
    track: FloatTrack,
    clipId: string,
    deltaSec: number,
    clientY: number,
  ) => void;
  commitFloatTrim: (
    track: FloatTrack,
    clipId: string,
    edge: "in" | "out",
    deltaSec: number,
  ) => void;
  commitGroupMove: (track: FloatTrack, ids: string[], deltaSec: number) => void;
  registerRow: (key: string, el: HTMLDivElement | null) => void;
  onAddTrack: (kind: FloatTrack) => void;
  onRemoveTrack: (trackId: string) => void;
}) {
  /** One kind's whole section: one TrackRow per real layer, plus the "+"
   *  strip. Colors/labels/handlers are identical across every layer of a
   *  kind — only which clips land in which row differs. */
  const renderKindSection = (
    kind: FloatTrack,
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
            move: (id, d, track, clientY) =>
              commitFloatMove(track as FloatTrack, id, d, clientY),
            trim: (id, edge, d, track) =>
              commitFloatTrim(track as FloatTrack, id, edge, d),
          }}
          track={kind}
          selection={selection}
          onSelect={onSelect}
          onGroupMove={commitGroupMove}
          pxPerSec={pxPerSec}
          resolveDragSnap={resolveDragSnap}
          onSnapGuide={onSnapGuide}
          registerRow={registerRow}
          rowKey={`${kind}:${g.track.id}`}
          // Only ever offered when there's a spare layer of this kind to
          // fall back to — removing the only/last one would just leave
          // nothing for the next add* op to attach to until
          // normalizeAllTracks reinvents one, a confusing thing for a
          // button to visibly do.
          onRemove={
            g.clips.length === 0 && groups.length > 1
              ? () => onRemoveTrack(g.track.id)
              : undefined
          }
        />
      ))}
      <AddTrackRow kind={kind} onAdd={onAddTrack} registerRow={registerRow} />
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

      <TrackRow
        label="Video"
        clips={videoClips}
        colorClass={TRACK_COLOR.video}
        handlers={{ move: commitVideoMove, trim: commitVideoTrim }}
        track="video"
        selection={selection}
        onSelect={onSelect}
        pxPerSec={pxPerSec}
        resolveDragSnap={resolveDragSnap}
        onSnapGuide={onSnapGuide}
        snapMove={false}
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
      {/* Overlays (text/image/video) get their own section, independent of
          captions — each is a true CapCut-style layer with its own
          start/end, freely draggable onto any OTHER overlay layer (or a
          brand-new one) without touching anything else, and never sharing
          a lane with the dozens of word-level caption chips a transcript
          produces the way one merged row used to. */}
      {renderKindSection("overlay", overlayGroups, TRACK_COLOR.text)}
      {renderKindSection("captions", captionGroups, TRACK_COLOR.captions)}
      {/* Music and sfx each get their own section for the same reason
          overlays and captions were split above — a music bed's edges
          shouldn't have to fight a burst of short sfx clips (or vice
          versa) for lane space, and each can now have several independent
          layers of its own. */}
      {renderKindSection("music", musicGroups, TRACK_COLOR.music)}
      {renderKindSection("sfx", sfxGroups, TRACK_COLOR.sfx)}
    </>
  );
});

export function Timeline({
  edl,
  selection,
  onSelect,
  currentTimeSec,
  onSeek,
  onOp,
}: {
  edl: Edl;
  selection: Selection;
  onSelect: (s: Selection) => void;
  currentTimeSec: number;
  onSeek: (sec: number) => void;
  onOp: (op: TimelineOp) => void;
}) {
  const [pxPerSec, setPxPerSec] = useState(70);
  const [containerWidth, setContainerWidth] = useState(800);
  // Snapping: dragged clips and the scrubbed playhead latch onto nearby
  // boundaries (see snapping.ts and resolveDragSnap below), with the green
  // guide marking each hit. The video row is the one place it means
  // something different — that track is always kept contiguous (see
  // recomputeVideoTrack in timelineOps.ts), so a drag there reorders rather
  // than repositions, and the flag instead controls how far a clip must
  // travel to count as having passed a neighbor: off, FREE_MOVE_BIAS pulls
  // that threshold in so a smaller deliberate drag commits the move (see
  // commitVideoMove).
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
  const overlayGroups = useMemo(
    () => groupByTrack(edl.tracks, "overlay", overlayClips),
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

  // Every per-layer row (plus each kind's own "+ new layer" strip)
  // registers its live DOM element here, keyed `${kind}:${trackId}` (or
  // `${kind}:new`) — populated by ref callbacks as rows mount/unmount, so
  // this never goes stale the way a once-measured, cached rect would after
  // a scroll or a layout change. Read only at the END of a drag (see
  // pickTrackAt) — a ref, not state, because updating it on every mount
  // must never itself trigger a re-render.
  const rowElsRef = useRef(new Map<string, HTMLDivElement>());
  const registerRow = useCallback((key: string, el: HTMLDivElement | null) => {
    if (el) rowElsRef.current.set(key, el);
    else rowElsRef.current.delete(key);
  }, []);

  /** Hit-tests a drag's final screen Y against every registered row of the
   *  given kind, fresh (getBoundingClientRect, not a cached value) since
   *  this only ever runs once, at drop time. Returns undefined when the
   *  pointer landed outside every row of this kind (e.g. over the ruler,
   *  or between sections) — the caller's own fallback is "just do the
   *  ordinary same-row move," so an inconclusive hit-test never loses the
   *  drag entirely. */
  const pickTrackAt = useCallback(
    (kind: FloatTrack, clientY: number): { trackId?: string } | undefined => {
      for (const [key, el] of rowElsRef.current) {
        if (!key.startsWith(`${kind}:`)) continue;
        const rect = el.getBoundingClientRect();
        if (clientY < rect.top || clientY >= rect.bottom) continue;
        const suffix = key.slice(kind.length + 1);
        return suffix === "new" ? {} : { trackId: suffix };
      }
      return undefined;
    },
    [],
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

  const commitVideoMove = useCallback(
    (clipId: string, deltaSec: number) => {
      const clip = edl.video.find((v) => v.id === clipId);
      if (!clip) return;
      const width = clip.tlOutSec - clip.tlInSec;
      // In free-move mode, push the comparison point further along in the
      // drag direction than the cursor actually traveled — shrinking how
      // far a clip has to move before it's judged to have passed a
      // neighbor, without changing the underlying "insert nearest by
      // center" rule.
      const bias = snapEnabled
        ? 0
        : Math.sign(deltaSec) * width * FREE_MOVE_BIAS;
      const newCenter = clip.tlInSec + width / 2 + deltaSec + bias;
      const toIndex = edl.video.filter(
        (other) =>
          other.id !== clipId &&
          other.tlInSec + (other.tlOutSec - other.tlInSec) / 2 < newCenter,
      ).length;
      onOp({ type: "reorder", id: clipId, toIndex });
    },
    [edl.video, onOp, snapEnabled],
  );

  const commitVideoTrim = useCallback(
    (clipId: string, edge: "in" | "out", deltaSec: number) => {
      const clip = edl.video.find((v) => v.id === clipId);
      if (!clip) return;
      // A drag can overshoot past the timeline's own start (a fast pointer
      // move easily travels further than the clip has room for) — clamped
      // to 0 rather than sent through and rejected by the server's own
      // tlSec >= 0 check, same as commitFloatMove already does for a move.
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

  const commitFloatMove = useCallback(
    (track: FloatTrack, clipId: string, deltaSec: number, clientY: number) => {
      const clips =
        track === "overlay"
          ? edl.overlays
          : track === "sfx"
            ? edl.sfx
            : track === "captions"
              ? edl.captions
              : edl.music;
      const clip = clips.find((c) => c.id === clipId);
      if (!clip) return;
      const tlInSec = Math.max(0, clip.tlInSec + deltaSec);

      // pickTrackAt tells us which row (if any) the pointer ended up over.
      // Nothing conclusive (dropped over the ruler, between sections, or
      // — the common case — never left its own row) or it's simply the
      // clip's own current layer: an ordinary same-layer reposition, same
      // as before this feature existed. Anything else — a different
      // existing layer of the SAME kind, or the kind's own "+ new layer"
      // strip (an empty `trackId`-less hit) — is a genuine drag-to-another-
      // layer gesture, retracked and retimed together in one atomic edit.
      const hit = pickTrackAt(track, clientY);
      if (!hit || hit.trackId === clip.trackId) {
        onOp({ type: "move", track, id: clipId, tlInSec });
        return;
      }
      onOp({
        type: "moveToTrack",
        kind: track,
        id: clipId,
        trackId: hit.trackId,
        tlInSec,
      });
    },
    [edl.overlays, edl.sfx, edl.captions, edl.music, onOp, pickTrackAt],
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

  // The explicit "+" affordance under each kind's group of layers — same
  // outcome dragging a clip down onto that same strip produces, just
  // without a clip in hand yet.
  const onAddTrack = useCallback(
    (kind: FloatTrack) => {
      onOp({ type: "addTrack", kind });
    },
    [onOp],
  );

  const onRemoveTrack = useCallback(
    (trackId: string) => {
      onOp({ type: "removeTrack", trackId });
    },
    [onOp],
  );

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
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(TEXT_OVERLAY_DRAG_TYPE)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes(TEXT_OVERLAY_DRAG_TYPE)) return;
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          const x =
            e.clientX -
            rect.left +
            e.currentTarget.scrollLeft -
            TRACK_LABEL_WIDTH;
          onOp(buildAddTextOverlayOp(Math.max(0, x / pxPerSec)));
        }}
      >
        <div style={{ width: contentWidth }} className="relative">
          <TimelineTracks
            pxPerSec={pxPerSec}
            majorTicks={majorTicks}
            minorTicks={minorTicks}
            useFrames={useFrames}
            fps={edl.fps}
            videoClips={videoClips}
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
            commitVideoMove={commitVideoMove}
            commitVideoTrim={commitVideoTrim}
            commitTransitionMove={commitTransitionMove}
            commitTransitionTrim={commitTransitionTrim}
            commitFloatMove={commitFloatMove}
            commitFloatTrim={commitFloatTrim}
            commitGroupMove={commitGroupMove}
            registerRow={registerRow}
            onAddTrack={onAddTrack}
            onRemoveTrack={onRemoveTrack}
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

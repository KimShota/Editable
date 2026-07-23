"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Edl } from "@backend/pipeline/types";
import type { TimelineOp } from "@backend/pipeline/timelineOps";
import { TimelineClip } from "./TimelineClip";
import { assignLanes, laneCount } from "./lanes";
import { isSelected, Selection, SelectionTrack, toggleSelect, MUSIC_ID } from "./selection";
import { buildMajorLadder, chooseTickScale, formatTick } from "./tickScale";
import { FitIcon, ScissorsIcon, TrashIcon, ZoomInIcon, ZoomOutIcon } from "./Icons";

/** One hue family (indigo → violet → purple) so tracks read as a system;
 *  transitions get the one intentional exception (amber) since they're a
 *  different kind of thing — an effect marker, not a content clip. */
const TRACK_COLOR = {
  video: "bg-indigo-500/85",
  transition: "bg-amber-500/75",
  text: "bg-violet-500/80",
  sfx: "bg-purple-400/75",
  captions: "bg-white/12",
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

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

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
};

type FloatTrack = "overlay" | "sfx" | "captions";

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
}: {
  label: string;
  clips: ClipView[];
  colorClass: string;
  handlers: {
    move?: (id: string, deltaSec: number) => void;
    trim?: (id: string, edge: "in" | "out", deltaSec: number) => void;
  };
  track: SelectionTrack;
  selection: Selection;
  onSelect: (s: Selection) => void;
  /** Only the three free-floating tracks support "drag one, group moves
   *  together" — video is contiguous (reorder, not a free move) and
   *  transition/music are always singletons. */
  onGroupMove?: (track: FloatTrack, ids: string[], deltaSec: number) => void;
  pxPerSec: number;
  locked?: boolean;
  trimEdges?: ("in" | "out")[];
}) {
  const lanes = useMemo(() => assignLanes(clips), [clips]);
  const rowHeight = laneCount(lanes) * LANE_HEIGHT;
  const containerRef = useRef<HTMLDivElement>(null);
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
    setMarquee({ startX: x, startY: y, curX: x, curY: y, additive: e.shiftKey });
  };

  const onMarqueeMove = (e: React.PointerEvent) => {
    if (!marquee) return;
    const rect = containerRef.current!.getBoundingClientRect();
    setMarquee((m) => (m ? { ...m, curX: e.clientX - rect.left, curY: e.clientY - rect.top } : m));
  };

  const endMarquee = (e: React.PointerEvent) => {
    if (!marquee) return;
    e.stopPropagation();
    const x0 = Math.min(marquee.startX, marquee.curX);
    const x1 = Math.max(marquee.startX, marquee.curX);
    const y0 = Math.min(marquee.startY, marquee.curY);
    const y1 = Math.max(marquee.startY, marquee.curY);
    const dragged = x1 - x0 > MARQUEE_THRESHOLD_PX || y1 - y0 > MARQUEE_THRESHOLD_PX;
    const additive = marquee.additive;
    setMarquee(null);

    if (!dragged) {
      if (!additive) onSelect(null);
      return;
    }
    const hitIds = clips
      .filter((c) => {
        const left = c.tlInSec * pxPerSec;
        const width = (c.tlOutSec - c.tlInSec) * pxPerSec;
        const top = (lanes.get(c.id) ?? 0) * LANE_HEIGHT;
        return left < x1 && left + width > x0 && top < y1 && top + LANE_HEIGHT > y0;
      })
      .map((c) => c.id);

    if (hitIds.length === 0) {
      if (!additive) onSelect(null);
      return;
    }
    if (additive && selection?.track === track) {
      const merged = new Set(selection.ids);
      for (const id of hitIds) merged.add(id);
      onSelect({ track, ids: Array.from(merged) });
    } else {
      onSelect({ track, ids: hitIds });
    }
  };

  return (
    <div className="relative flex border-b border-[color:var(--ed-border)]" style={{ height: rowHeight }}>
      <div className="sticky left-0 z-20 flex w-24 shrink-0 items-center gap-2 bg-[color:var(--ed-panel)] px-3 text-[11px] text-[color:var(--ed-ink-dim)]">
        <span className={`h-2 w-2 shrink-0 rounded-[3px] ${colorClass}`} />
        {label}
      </div>
      <div
        ref={containerRef}
        className="relative flex-1"
        onPointerDown={beginMarquee}
        onPointerMove={onMarqueeMove}
        onPointerUp={endMarquee}
      >
        {clips.map((c) => (
          <TimelineClip
            key={c.id}
            left={c.tlInSec * pxPerSec}
            width={(c.tlOutSec - c.tlInSec) * pxPerSec}
            top={(lanes.get(c.id) ?? 0) * LANE_HEIGHT}
            height={LANE_HEIGHT}
            label={c.label}
            sublabel={c.sublabel}
            thumbnailSrc={c.thumbnailSrc}
            colorClass={colorClass}
            selected={isSelected(selection, track, c.id)}
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
                !additive && selection?.track === track && selection.ids.length > 1 && selection.ids.includes(c.id);
              if (inExistingGroup) return;
              onSelect(toggleSelect(selection, track, c.id, additive));
            }}
            onCommitMove={
              handlers.move
                ? (d) => {
                    // Dragging any one clip of an active multi-selection
                    // shifts the whole group by the same delta, in one
                    // atomic edit — otherwise it's just that one clip.
                    if (
                      onGroupMove &&
                      selection?.track === track &&
                      selection.ids.length > 1 &&
                      selection.ids.includes(c.id)
                    ) {
                      onGroupMove(track as FloatTrack, selection.ids, d);
                    } else {
                      handlers.move!(c.id, d);
                    }
                  }
                : undefined
            }
            onCommitTrim={handlers.trim ? (edge, d) => handlers.trim!(c.id, edge, d) : undefined}
          />
        ))}
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

/**
 * Everything on the timeline that does NOT depend on the playhead position:
 * the ruler and all six track rows (~126 clips at a typical job's size).
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
  overlayClips,
  sfxClips,
  transitionClips,
  captionClips,
  musicView,
  selection,
  onSelect,
  onRulerPointerDown,
  onRulerPointerMove,
  commitVideoMove,
  commitVideoTrim,
  commitTransitionMove,
  commitTransitionTrim,
  commitFloatMove,
  commitFloatTrim,
  commitGroupMove,
  commitMusicMove,
  commitMusicTrim,
}: {
  pxPerSec: number;
  majorTicks: number[];
  minorTicks: number[];
  useFrames: boolean;
  fps: number;
  videoClips: ClipView[];
  overlayClips: ClipView[];
  sfxClips: ClipView[];
  transitionClips: ClipView[];
  captionClips: ClipView[];
  musicView: ClipView | null;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onRulerPointerDown: (e: React.PointerEvent) => void;
  onRulerPointerMove: (e: React.PointerEvent) => void;
  commitVideoMove: (clipId: string, deltaSec: number) => void;
  commitVideoTrim: (clipId: string, edge: "in" | "out", deltaSec: number) => void;
  commitTransitionMove: (afterClipId: string, deltaSec: number) => void;
  commitTransitionTrim: (afterClipId: string, edge: "in" | "out", deltaSec: number) => void;
  commitFloatMove: (track: FloatTrack, clipId: string, deltaSec: number) => void;
  commitFloatTrim: (
    track: FloatTrack,
    clipId: string,
    edge: "in" | "out",
    deltaSec: number,
  ) => void;
  commitGroupMove: (track: FloatTrack, ids: string[], deltaSec: number) => void;
  commitMusicMove: (deltaSec: number) => void;
  commitMusicTrim: (edge: "in" | "out", deltaSec: number) => void;
}) {
  return (
    <>
      {/* Ruler — click to jump, drag to scrub continuously */}
      <div
        className="sticky top-0 z-20 flex h-6 cursor-text border-b border-[color:var(--ed-border)] bg-[color:var(--ed-panel)]"
        onPointerDown={onRulerPointerDown}
        onPointerMove={onRulerPointerMove}
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
          trimEdges={OUT_TRIM_EDGE_ONLY}
        />
      )}
      <TrackRow
        label="Text & Media"
        clips={overlayClips}
        colorClass={TRACK_COLOR.text}
        handlers={{
          move: (id, d) => commitFloatMove("overlay", id, d),
          trim: (id, edge, d) => commitFloatTrim("overlay", id, edge, d),
        }}
        track="overlay"
        selection={selection}
        onSelect={onSelect}
        onGroupMove={commitGroupMove}
        pxPerSec={pxPerSec}
      />
      <TrackRow
        label="SFX"
        clips={sfxClips}
        colorClass={TRACK_COLOR.sfx}
        handlers={{
          move: (id, d) => commitFloatMove("sfx", id, d),
          trim: (id, edge, d) => commitFloatTrim("sfx", id, edge, d),
        }}
        track="sfx"
        selection={selection}
        onSelect={onSelect}
        onGroupMove={commitGroupMove}
        pxPerSec={pxPerSec}
      />
      {captionClips.length > 0 && (
        <TrackRow
          label="Captions"
          clips={captionClips}
          colorClass={TRACK_COLOR.captions}
          handlers={{
            move: (id, d) => commitFloatMove("captions", id, d),
            trim: (id, edge, d) => commitFloatTrim("captions", id, edge, d),
          }}
          track="captions"
          selection={selection}
          onSelect={onSelect}
          onGroupMove={commitGroupMove}
          pxPerSec={pxPerSec}
        />
      )}
      {musicView && (
        <TrackRow
          label="Music"
          clips={[musicView]}
          colorClass={TRACK_COLOR.music}
          handlers={{ move: (_id, d) => commitMusicMove(d), trim: (_id, edge, d) => commitMusicTrim(edge, d) }}
          track="music"
          selection={selection}
          onSelect={onSelect}
          pxPerSec={pxPerSec}
        />
      )}
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScrollLeft = useRef<number | null>(null);

  // "Full overview" = the whole video fits in the visible width with no
  // scrolling; "frame-level precision" = zoomed in enough to tell
  // individual frames apart. Both ends of the zoom range are derived from
  // the actual video, not arbitrary constants.
  const minPxPerSec = Math.max(2, (containerWidth - TRACK_LABEL_WIDTH) / Math.max(edl.durationSec, 0.1));
  const maxPxPerSec = Math.max(minPxPerSec * 4, edl.fps * PX_PER_FRAME_AT_MAX_ZOOM);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setContainerWidth(entries[0].contentRect.width));
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

  const zoomAround = (clientX: number, zoomFactor: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pointerX = clientX - rect.left;
    const cursorSec = (pointerX + el.scrollLeft - TRACK_LABEL_WIDTH) / pxPerSec;
    const next = clamp(pxPerSec * zoomFactor, minPxPerSec, maxPxPerSec);
    pendingScrollLeft.current = Math.max(0, cursorSec * next + TRACK_LABEL_WIDTH - pointerX);
    setPxPerSec(next);
  };

  // Ctrl/Cmd+scroll (trackpad pinch maps to this too) zooms, centered on
  // the cursor — plain scroll still pans the timeline natively.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoomAround(e.clientX, Math.exp(-e.deltaY * 0.0025));
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
      })),
    [edl.video],
  );

  const overlayClips: ClipView[] = useMemo(
    () =>
      edl.overlays.map((o) => {
        const src = typeof o.params.src === "string" ? o.params.src : undefined;
        const text = typeof o.params.text === "string" ? o.params.text : undefined;
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
          thumbnailSrc: o.component === "ImageOverlay" && src ? `/${src}` : undefined,
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
      })),
    [edl.captions],
  );

  const musicView: ClipView | null = useMemo(
    () =>
      edl.music
        ? {
            id: MUSIC_ID,
            tlInSec: edl.music.tlInSec,
            tlOutSec: edl.music.tlInSec + (edl.music.durationSec ?? edl.durationSec - edl.music.tlInSec),
            label: edl.music.src.split("/").pop() ?? "music",
          }
        : null,
    [edl.music, edl.durationSec],
  );

  const contentWidth = Math.max(600, (edl.durationSec + 3) * pxPerSec);

  const majorLadder = useMemo(() => buildMajorLadder(edl.fps), [edl.fps]);
  const { majorSec, minorSec, useFrames } = chooseTickScale(pxPerSec, edl.fps, majorLadder);

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
      onSeek(Math.max(0, x / pxPerSec));
    },
    [onSeek, pxPerSec],
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

  const commitVideoMove = useCallback(
    (clipId: string, deltaSec: number) => {
      const clip = edl.video.find((v) => v.id === clipId);
      if (!clip) return;
      const newCenter = clip.tlInSec + (clip.tlOutSec - clip.tlInSec) / 2 + deltaSec;
      const toIndex = edl.video.filter(
        (other) => other.id !== clipId && other.tlInSec + (other.tlOutSec - other.tlInSec) / 2 < newCenter,
      ).length;
      onOp({ type: "reorder", id: clipId, toIndex });
    },
    [edl.video, onOp],
  );

  const commitVideoTrim = useCallback(
    (clipId: string, edge: "in" | "out", deltaSec: number) => {
      const clip = edl.video.find((v) => v.id === clipId);
      if (!clip) return;
      const tlSec = (edge === "in" ? clip.tlInSec : clip.tlOutSec) + deltaSec;
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
      if (bestId !== afterClipId) onOp({ type: "moveTransition", fromId: afterClipId, toId: bestId });
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
    (track: FloatTrack, clipId: string, deltaSec: number) => {
      const clips = track === "overlay" ? edl.overlays : track === "sfx" ? edl.sfx : edl.captions;
      const clip = clips.find((c) => c.id === clipId);
      if (!clip) return;
      onOp({ type: "move", track, id: clipId, tlInSec: Math.max(0, clip.tlInSec + deltaSec) });
    },
    [edl.overlays, edl.sfx, edl.captions, onOp],
  );

  const commitFloatTrim = useCallback(
    (track: FloatTrack, clipId: string, edge: "in" | "out", deltaSec: number) => {
      const view =
        track === "overlay"
          ? overlayClips.find((c) => c.id === clipId)
          : track === "sfx"
            ? sfxClips.find((c) => c.id === clipId)
            : captionClips.find((c) => c.id === clipId);
      if (!view) return;
      const tlSec = (edge === "in" ? view.tlInSec : view.tlOutSec) + deltaSec;
      onOp({ type: "trimEdge", track, id: clipId, edge, tlSec });
    },
    [overlayClips, sfxClips, captionClips, onOp],
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

  const commitMusicMove = useCallback(
    (deltaSec: number) => {
      if (!edl.music) return;
      onOp({ type: "move", track: "music", id: MUSIC_ID, tlInSec: Math.max(0, edl.music.tlInSec + deltaSec) });
    },
    [edl.music, onOp],
  );

  const commitMusicTrim = useCallback(
    (edge: "in" | "out", deltaSec: number) => {
      if (!musicView) return;
      const tlSec = (edge === "in" ? musicView.tlInSec : musicView.tlOutSec) + deltaSec;
      onOp({ type: "trimEdge", track: "music", id: MUSIC_ID, edge, tlSec });
    },
    [musicView, onOp],
  );

  // Toolbar split/delete act on whatever's currently selected — a shortcut
  // for the same actions available per-clip in the Inspector. Only the
  // four real clip tracks support split/delete (transitions/music don't).
  const isSplittableTrack = (t: SelectionTrack): t is "video" | "overlay" | "sfx" | "captions" =>
    t === "video" || t === "overlay" || t === "sfx" || t === "captions";

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
    isSplittableTrack(selection.track) &&
    !(selection.track === "video" && edl.video.length - selection.ids.length <= 0);

  const splitSelection = () => {
    if (!selection || selection.ids.length !== 1 || !isSplittableTrack(selection.track)) return;
    onOp({ type: "split", track: selection.track, id: selection.ids[0], atSec: currentTimeSec });
  };

  const deleteSelection = () => {
    if (!selection || !isSplittableTrack(selection.track)) return;
    onOp({ type: "deleteMany", track: selection.track, ids: selection.ids });
  };

  const toolbarBtnClass =
    "flex h-7 w-7 items-center justify-center rounded-lg text-[color:var(--ed-ink-dim)] transition-colors hover:bg-[color:var(--ed-raised)] hover:text-[color:var(--ed-ink)] disabled:pointer-events-none disabled:opacity-30";

  return (
    <div className="flex h-full flex-col bg-[color:var(--ed-panel)]">
      <div className="flex items-center justify-between border-b border-[color:var(--ed-border)] px-2.5 py-1.5">
        <div className="flex items-center gap-1">
          {selection && selection.ids.length > 1 && (
            <span className="mr-1 text-[11px] text-[color:var(--ed-ink-dim)]">{selection.ids.length} selected</span>
          )}
          <button onClick={splitSelection} disabled={!canSplitSelection} title="Split at playhead" className={toolbarBtnClass}>
            <ScissorsIcon className="h-4 w-4" />
          </button>
          <button onClick={deleteSelection} disabled={!canDeleteSelection} title="Delete selected clip(s)" className={toolbarBtnClass}>
            <TrashIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button onClick={() => setPxPerSec(minPxPerSec)} title="Fit whole video to view" className={toolbarBtnClass}>
            <FitIcon className="h-4 w-4" />
          </button>
          <button
            onClick={() => setPxPerSec((v) => clamp(v / 1.4, minPxPerSec, maxPxPerSec))}
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
            onChange={(e) => setPxPerSec(Number(e.target.value))}
            className="w-24 accent-[color:var(--ed-accent)]"
            title="Zoom"
          />
          <button
            onClick={() => setPxPerSec((v) => clamp(v * 1.4, minPxPerSec, maxPxPerSec))}
            title="Zoom in"
            className={toolbarBtnClass}
          >
            <ZoomInIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="relative flex-1 overflow-x-auto overflow-y-auto" onClick={() => onSelect(null)}>
        <div style={{ width: contentWidth }} className="relative">
          <TimelineTracks
            pxPerSec={pxPerSec}
            majorTicks={majorTicks}
            minorTicks={minorTicks}
            useFrames={useFrames}
            fps={edl.fps}
            videoClips={videoClips}
            overlayClips={overlayClips}
            sfxClips={sfxClips}
            transitionClips={transitionClips}
            captionClips={captionClips}
            musicView={musicView}
            selection={selection}
            onSelect={onSelect}
            onRulerPointerDown={onRulerPointerDown}
            onRulerPointerMove={onRulerPointerMove}
            commitVideoMove={commitVideoMove}
            commitVideoTrim={commitVideoTrim}
            commitTransitionMove={commitTransitionMove}
            commitTransitionTrim={commitTransitionTrim}
            commitFloatMove={commitFloatMove}
            commitFloatTrim={commitFloatTrim}
            commitGroupMove={commitGroupMove}
            commitMusicMove={commitMusicMove}
            commitMusicTrim={commitMusicTrim}
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
              className="pointer-events-auto absolute -top-0.5 -left-2.5 h-5 w-5 cursor-ew-resize rounded-full bg-[color:var(--ed-accent)] ring-2 ring-[color:var(--ed-panel)]"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Edl } from "@backend/pipeline/types";
import type { TimelineOp } from "@backend/pipeline/timelineOps";
import { TimelineClip } from "./TimelineClip";
import { Selection, SelectionTrack, MUSIC_ID } from "./selection";
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

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

// Stable array references — an inline `["in", "out"]` literal at a call
// site is a fresh array every render, which would defeat TimelineTracks'
// memoization even though the two track-color/trim-edge configs never
// actually change.
const BOTH_TRIM_EDGES: ("in" | "out")[] = ["in", "out"];
const OUT_TRIM_EDGE_ONLY: ("in" | "out")[] = ["out"];

type ClipView = { id: string; tlInSec: number; tlOutSec: number; label: string; sublabel?: string };

const trackRow = (
  label: string,
  clips: ClipView[],
  colorClass: string,
  handlers: {
    move?: (id: string, deltaSec: number) => void;
    trim?: (id: string, edge: "in" | "out", deltaSec: number) => void;
  },
  track: SelectionTrack,
  selection: Selection,
  onSelect: (s: Selection) => void,
  pxPerSec: number,
  locked = false,
  trimEdges: ("in" | "out")[] = BOTH_TRIM_EDGES,
) => (
  <div key={track} className="relative flex h-14 border-b border-[color:var(--ed-border)]">
    <div className="sticky left-0 z-20 flex w-24 shrink-0 items-center gap-2 bg-[color:var(--ed-panel)] px-3 text-[11px] text-[color:var(--ed-ink-dim)]">
      <span className={`h-2 w-2 shrink-0 rounded-[3px] ${colorClass}`} />
      {label}
    </div>
    <div className="relative flex-1">
      {clips.map((c) => (
        <TimelineClip
          key={c.id}
          left={c.tlInSec * pxPerSec}
          width={(c.tlOutSec - c.tlInSec) * pxPerSec}
          label={c.label}
          sublabel={c.sublabel}
          colorClass={colorClass}
          selected={selection?.track === track && selection.id === c.id}
          locked={locked}
          trimEdges={trimEdges}
          pxPerSec={pxPerSec}
          onSelect={() => onSelect({ track, id: c.id })}
          onCommitMove={handlers.move ? (d) => handlers.move!(c.id, d) : undefined}
          onCommitTrim={handlers.trim ? (edge, d) => handlers.trim!(c.id, edge, d) : undefined}
        />
      ))}
    </div>
  </div>
);

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
  commitFloatMove: (track: "overlay" | "sfx" | "captions", clipId: string, deltaSec: number) => void;
  commitFloatTrim: (
    track: "overlay" | "sfx" | "captions",
    clipId: string,
    edge: "in" | "out",
    deltaSec: number,
  ) => void;
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

      {trackRow("Video", videoClips, TRACK_COLOR.video, { move: commitVideoMove, trim: commitVideoTrim }, "video", selection, onSelect, pxPerSec)}
      {transitionClips.length > 0 &&
        trackRow(
          "Transitions",
          transitionClips,
          TRACK_COLOR.transition,
          {
            move: (id, d) => commitTransitionMove(id, d),
            trim: (id, edge, d) => commitTransitionTrim(id, edge, d),
          },
          "transition",
          selection,
          onSelect,
          pxPerSec,
          false,
          OUT_TRIM_EDGE_ONLY,
        )}
      {trackRow(
        "Text",
        overlayClips,
        TRACK_COLOR.text,
        {
          move: (id, d) => commitFloatMove("overlay", id, d),
          trim: (id, edge, d) => commitFloatTrim("overlay", id, edge, d),
        },
        "overlay",
        selection,
        onSelect,
        pxPerSec,
      )}
      {trackRow(
        "SFX",
        sfxClips,
        TRACK_COLOR.sfx,
        {
          move: (id, d) => commitFloatMove("sfx", id, d),
          trim: (id, edge, d) => commitFloatTrim("sfx", id, edge, d),
        },
        "sfx",
        selection,
        onSelect,
        pxPerSec,
      )}
      {captionClips.length > 0 &&
        trackRow(
          "Captions",
          captionClips,
          TRACK_COLOR.captions,
          {
            move: (id, d) => commitFloatMove("captions", id, d),
            trim: (id, edge, d) => commitFloatTrim("captions", id, edge, d),
          },
          "captions",
          selection,
          onSelect,
          pxPerSec,
        )}
      {musicView &&
        trackRow(
          "Music",
          [musicView],
          TRACK_COLOR.music,
          { move: (_id, d) => commitMusicMove(d), trim: (_id, edge, d) => commitMusicTrim(edge, d) },
          "music",
          selection,
          onSelect,
          pxPerSec,
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
      edl.overlays.map((o) => ({
        id: o.id,
        tlInSec: o.tlInSec,
        tlOutSec: o.tlOutSec,
        label: o.component,
        sublabel: typeof o.params.text === "string" ? o.params.text : undefined,
      })),
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
    (track: "overlay" | "sfx" | "captions", clipId: string, deltaSec: number) => {
      const clips = track === "overlay" ? edl.overlays : track === "sfx" ? edl.sfx : edl.captions;
      const clip = clips.find((c) => c.id === clipId);
      if (!clip) return;
      onOp({ type: "move", track, id: clipId, tlInSec: Math.max(0, clip.tlInSec + deltaSec) });
    },
    [edl.overlays, edl.sfx, edl.captions, onOp],
  );

  const commitFloatTrim = useCallback(
    (track: "overlay" | "sfx" | "captions", clipId: string, edge: "in" | "out", deltaSec: number) => {
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

  const selectedClipView: ClipView | undefined = selection
    ? selection.track === "video"
      ? videoClips.find((c) => c.id === selection.id)
      : selection.track === "overlay"
        ? overlayClips.find((c) => c.id === selection.id)
        : selection.track === "sfx"
          ? sfxClips.find((c) => c.id === selection.id)
          : selection.track === "captions"
            ? captionClips.find((c) => c.id === selection.id)
            : undefined
    : undefined;

  const canSplitSelection =
    !!selection &&
    isSplittableTrack(selection.track) &&
    !!selectedClipView &&
    currentTimeSec > selectedClipView.tlInSec + 0.1 &&
    currentTimeSec < selectedClipView.tlOutSec - 0.1;

  const canDeleteSelection =
    !!selection &&
    isSplittableTrack(selection.track) &&
    !(selection.track === "video" && edl.video.length <= 1);

  const splitSelection = () => {
    if (!selection || !isSplittableTrack(selection.track)) return;
    onOp({ type: "split", track: selection.track, id: selection.id, atSec: currentTimeSec });
  };

  const deleteSelection = () => {
    if (!selection || !isSplittableTrack(selection.track)) return;
    onOp({ type: "delete", track: selection.track, id: selection.id });
  };

  const toolbarBtnClass =
    "flex h-7 w-7 items-center justify-center rounded-lg text-[color:var(--ed-ink-dim)] transition-colors hover:bg-[color:var(--ed-raised)] hover:text-[color:var(--ed-ink)] disabled:pointer-events-none disabled:opacity-30";

  return (
    <div className="flex h-full flex-col bg-[color:var(--ed-panel)]">
      <div className="flex items-center justify-between border-b border-[color:var(--ed-border)] px-2.5 py-1.5">
        <div className="flex items-center gap-1">
          <button onClick={splitSelection} disabled={!canSplitSelection} title="Split at playhead" className={toolbarBtnClass}>
            <ScissorsIcon className="h-4 w-4" />
          </button>
          <button onClick={deleteSelection} disabled={!canDeleteSelection} title="Delete selected clip" className={toolbarBtnClass}>
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

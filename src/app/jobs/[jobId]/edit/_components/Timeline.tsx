"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Edl } from "@backend/pipeline/types";
import type { TimelineOp } from "@backend/pipeline/timelineOps";
import { TimelineClip } from "./TimelineClip";
import { Selection, SelectionTrack, MUSIC_ID } from "./selection";
import { buildMajorLadder, chooseTickScale, formatTick } from "./tickScale";

const TRACK_LABEL_WIDTH = 96;
/** Frame-level precision: enough px/frame that individual frames are
 *  visually distinct once fully zoomed in. */
const PX_PER_FRAME_AT_MAX_ZOOM = 12;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

type ClipView = { id: string; tlInSec: number; tlOutSec: number; label: string; sublabel?: string };

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

  const seekFromClientX = (clientX: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft;
    onSeek(Math.max(0, x / pxPerSec));
  };

  const commitVideoMove = (clipId: string, deltaSec: number) => {
    const clip = edl.video.find((v) => v.id === clipId);
    if (!clip) return;
    const newCenter = clip.tlInSec + (clip.tlOutSec - clip.tlInSec) / 2 + deltaSec;
    const toIndex = edl.video.filter(
      (other) => other.id !== clipId && other.tlInSec + (other.tlOutSec - other.tlInSec) / 2 < newCenter,
    ).length;
    onOp({ type: "reorder", id: clipId, toIndex });
  };

  const commitVideoTrim = (clipId: string, edge: "in" | "out", deltaSec: number) => {
    const clip = edl.video.find((v) => v.id === clipId);
    if (!clip) return;
    const tlSec = (edge === "in" ? clip.tlInSec : clip.tlOutSec) + deltaSec;
    onOp({ type: "trimEdge", track: "video", id: clipId, edge, tlSec });
  };

  const commitFloatMove = (track: "overlay" | "sfx" | "captions", clipId: string, deltaSec: number) => {
    const clips = track === "overlay" ? edl.overlays : track === "sfx" ? edl.sfx : edl.captions;
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;
    onOp({ type: "move", track, id: clipId, tlInSec: Math.max(0, clip.tlInSec + deltaSec) });
  };

  const commitFloatTrim = (
    track: "overlay" | "sfx" | "captions",
    clipId: string,
    edge: "in" | "out",
    deltaSec: number,
  ) => {
    const view =
      track === "overlay"
        ? overlayClips.find((c) => c.id === clipId)
        : track === "sfx"
          ? sfxClips.find((c) => c.id === clipId)
          : captionClips.find((c) => c.id === clipId);
    if (!view) return;
    const tlSec = (edge === "in" ? view.tlInSec : view.tlOutSec) + deltaSec;
    onOp({ type: "trimEdge", track, id: clipId, edge, tlSec });
  };

  const musicView: ClipView | null = edl.music
    ? {
        id: MUSIC_ID,
        tlInSec: edl.music.tlInSec,
        tlOutSec: edl.music.tlInSec + (edl.music.durationSec ?? edl.durationSec - edl.music.tlInSec),
        label: edl.music.src.split("/").pop() ?? "music",
      }
    : null;

  const commitMusicMove = (deltaSec: number) => {
    if (!edl.music) return;
    onOp({ type: "move", track: "music", id: MUSIC_ID, tlInSec: Math.max(0, edl.music.tlInSec + deltaSec) });
  };

  const commitMusicTrim = (edge: "in" | "out", deltaSec: number) => {
    if (!musicView) return;
    const tlSec = (edge === "in" ? musicView.tlInSec : musicView.tlOutSec) + deltaSec;
    onOp({ type: "trimEdge", track: "music", id: MUSIC_ID, edge, tlSec });
  };

  const trackRow = (
    label: string,
    clips: ClipView[],
    colorClass: string,
    handlers: {
      move?: (id: string, deltaSec: number) => void;
      trim?: (id: string, edge: "in" | "out", deltaSec: number) => void;
    },
    track: SelectionTrack,
    locked = false,
  ) => (
    <div className="relative flex h-14 border-b border-white/6">
      <div className="sticky left-0 z-20 flex w-24 shrink-0 items-center bg-[color:var(--bg-2)] px-2 text-[11px] text-[color:var(--ink-dim)]">
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
            pxPerSec={pxPerSec}
            onSelect={() => onSelect({ track, id: c.id })}
            onCommitMove={handlers.move ? (d) => handlers.move!(c.id, d) : undefined}
            onCommitTrim={handlers.trim ? (edge, d) => handlers.trim!(c.id, edge, d) : undefined}
          />
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex h-full flex-col bg-[color:var(--bg-2)]">
      <div className="flex items-center justify-between border-b border-white/8 px-3 py-1.5">
        <p className="text-[11px] tracking-wide text-[color:var(--ink-dim)] uppercase">Timeline</p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPxPerSec(minPxPerSec)}
            title="Fit whole video to view"
            className="rounded px-2 h-6 text-[11px] text-[color:var(--ink-dim)] hover:bg-white/10 hover:text-[color:var(--ink)]"
          >
            Fit
          </button>
          <button
            onClick={() => setPxPerSec((v) => clamp(v / 1.4, minPxPerSec, maxPxPerSec))}
            className="h-6 w-6 rounded text-[color:var(--ink-dim)] hover:bg-white/10 hover:text-[color:var(--ink)]"
          >
            −
          </button>
          <input
            type="range"
            min={minPxPerSec}
            max={maxPxPerSec}
            step={(maxPxPerSec - minPxPerSec) / 200 || 1}
            value={pxPerSec}
            onChange={(e) => setPxPerSec(Number(e.target.value))}
            className="w-24"
            title="Zoom"
          />
          <button
            onClick={() => setPxPerSec((v) => clamp(v * 1.4, minPxPerSec, maxPxPerSec))}
            className="h-6 w-6 rounded text-[color:var(--ink-dim)] hover:bg-white/10 hover:text-[color:var(--ink)]"
          >
            +
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="relative flex-1 overflow-x-auto overflow-y-auto" onClick={() => onSelect(null)}>
        <div style={{ width: contentWidth }} className="relative">
          {/* Ruler — click to jump, drag to scrub continuously */}
          <div
            className="sticky top-0 z-20 flex h-6 cursor-text border-b border-white/8 bg-[color:var(--bg-2)]"
            onPointerDown={(e) => {
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              seekFromClientX(e.clientX);
            }}
            onPointerMove={(e) => {
              if (e.buttons !== 1) return;
              seekFromClientX(e.clientX);
            }}
          >
            <div className="w-24 shrink-0" />
            <div className="relative flex-1">
              {minorTicks.map((t) => (
                <div
                  key={`minor-${t}`}
                  style={{ left: t * pxPerSec }}
                  className="absolute bottom-0 h-1.5 border-l border-white/10"
                />
              ))}
              {majorTicks.map((t) => (
                <div
                  key={`major-${t}`}
                  style={{ left: t * pxPerSec }}
                  className="absolute top-0 h-full border-l border-white/20 pl-1 text-[10px] whitespace-nowrap text-[color:var(--ink-dim)]"
                >
                  {formatTick(t, useFrames, edl.fps)}
                </div>
              ))}
            </div>
          </div>

          {trackRow("Video", videoClips, "bg-indigo-600/80", { move: commitVideoMove, trim: commitVideoTrim }, "video")}
          {transitionClips.length > 0 &&
            trackRow("Transitions", transitionClips, "bg-amber-400/80", {}, "transition", true)}
          {trackRow(
            "Text",
            overlayClips,
            "bg-fuchsia-600/70",
            {
              move: (id, d) => commitFloatMove("overlay", id, d),
              trim: (id, edge, d) => commitFloatTrim("overlay", id, edge, d),
            },
            "overlay",
          )}
          {trackRow(
            "SFX",
            sfxClips,
            "bg-[color:var(--accent)]/70",
            {
              move: (id, d) => commitFloatMove("sfx", id, d),
              trim: (id, edge, d) => commitFloatTrim("sfx", id, edge, d),
            },
            "sfx",
          )}
          {edl.captions.length > 0 &&
            trackRow(
              "Captions",
              captionClips,
              "bg-white/15",
              {
                move: (id, d) => commitFloatMove("captions", id, d),
                trim: (id, edge, d) => commitFloatTrim("captions", id, edge, d),
              },
              "captions",
            )}
          {musicView &&
            trackRow(
              "Music",
              [musicView],
              "bg-violet-800/70",
              { move: (_id, d) => commitMusicMove(d), trim: (_id, edge, d) => commitMusicTrim(edge, d) },
              "music",
            )}

          {/* Playhead — the line is decorative only (so it doesn't block
              clicks on clips it passes over); the handle is the real,
              draggable control. */}
          <div
            style={{ left: currentTimeSec * pxPerSec + TRACK_LABEL_WIDTH }}
            className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-[color:var(--accent)]"
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
              className="pointer-events-auto absolute -top-0.5 -left-2.5 h-5 w-5 cursor-ew-resize rounded-full bg-[color:var(--accent)] ring-2 ring-[color:var(--bg-2)]"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

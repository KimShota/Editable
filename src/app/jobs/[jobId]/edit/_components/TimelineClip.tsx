"use client";

import { useRef, useState } from "react";

/**
 * One clip box on the timeline. Drag/trim gestures are ephemeral (a local
 * pixel offset shown during the pointer drag) and only turn into a real
 * edit — a call to onCommitMove/onCommitTrim — on release. The parent then
 * submits that as a timeline op and replaces the whole EDL from the
 * server's response, so the clip snaps to the authoritative (rippled)
 * position rather than this component trying to predict it.
 */

const CLICK_THRESHOLD_PX = 3;

export function TimelineClip({
  left,
  width,
  label,
  sublabel,
  colorClass,
  selected,
  locked = false,
  trimEdges = ["in", "out"],
  pxPerSec,
  onSelect,
  onCommitMove,
  onCommitTrim,
}: {
  left: number;
  width: number;
  label: string;
  sublabel?: string;
  colorClass: string;
  selected: boolean;
  locked?: boolean;
  /** Which edges show a resize handle, when onCommitTrim is given — a
   *  transition's leading edge is pinned to the cut it follows, so only
   *  its trailing edge (duration) is ever draggable. */
  trimEdges?: ("in" | "out")[];
  pxPerSec: number;
  onSelect: () => void;
  onCommitMove?: (deltaSec: number) => void;
  onCommitTrim?: (edge: "in" | "out", deltaSec: number) => void;
}) {
  const [dragPx, setDragPx] = useState(0);
  const [trimEdge, setTrimEdge] = useState<"in" | "out" | null>(null);
  const drag = useRef<{ startX: number; kind: "move" | "in" | "out" } | null>(null);

  const beginDrag = (e: React.PointerEvent, kind: "move" | "in" | "out") => {
    if (locked) return;
    e.stopPropagation();
    onSelect();
    // Move needs onCommitMove; a trim edge needs both onCommitTrim and to be
    // in trimEdges — otherwise this is a plain select-only click.
    if (kind === "move" ? !onCommitMove : !onCommitTrim || !trimEdges.includes(kind)) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, kind };
    if (kind !== "move") setTrimEdge(kind);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setDragPx(e.clientX - drag.current.startX);
  };

  const endDrag = () => {
    if (!drag.current) return;
    const { kind } = drag.current;
    const movedPx = dragPx;
    drag.current = null;
    setDragPx(0);
    setTrimEdge(null);
    if (Math.abs(movedPx) < CLICK_THRESHOLD_PX) return;
    const deltaSec = movedPx / pxPerSec;
    if (kind === "move") onCommitMove?.(deltaSec);
    else onCommitTrim?.(kind, deltaSec);
  };

  const previewLeft = trimEdge === "in" ? left + dragPx : left;
  const previewWidth =
    trimEdge === "in" ? width - dragPx : trimEdge === "out" ? width + dragPx : width;
  const translateX = trimEdge === null ? dragPx : 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onPointerDown={(e) => beginDrag(e, "move")}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onClick={(e) => e.stopPropagation()}
      style={{
        left: previewLeft,
        width: Math.max(previewWidth, 4),
        transform: `translateX(${translateX}px)`,
      }}
      className={`group absolute top-1 bottom-1 flex flex-col justify-center overflow-hidden rounded-lg border px-2 text-left transition-shadow duration-150 ${
        onCommitMove ? "cursor-grab active:cursor-grabbing" : "cursor-default"
      } ${colorClass} ${
        selected
          ? "z-10 border-[color:var(--ed-accent)] shadow-[0_0_0_3px_var(--ed-accent-dim)]"
          : "border-black/20"
      } ${locked ? "opacity-80" : ""}`}
    >
      <p className="truncate text-[11px] leading-tight font-medium text-white">{label}</p>
      {sublabel && <p className="truncate text-[10px] leading-tight text-white/70">{sublabel}</p>}

      {!locked && onCommitTrim && trimEdges.includes("in") && (
        <div
          onPointerDown={(e) => beginDrag(e, "in")}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          className="absolute top-0 bottom-0 left-0 w-2 cursor-ew-resize bg-white/0 group-hover:bg-white/25"
        />
      )}
      {!locked && onCommitTrim && trimEdges.includes("out") && (
        <div
          onPointerDown={(e) => beginDrag(e, "out")}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          className="absolute top-0 right-0 bottom-0 w-2 cursor-ew-resize bg-white/0 group-hover:bg-white/25"
        />
      )}
    </div>
  );
}

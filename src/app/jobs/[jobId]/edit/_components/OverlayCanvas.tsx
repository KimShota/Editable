"use client";

import { useEffect, useRef, useState } from "react";
import type { Edl } from "@backend/pipeline/types";
import type { TimelineOp } from "@backend/pipeline/timelineOps";
import { Selection, toggleSelect } from "./selection";

/**
 * The CapCut-style move/resize layer over the video preview: renders a
 * bounding box + corner handles for whichever overlay is selected, sitting
 * in the SAME aspect-ratio'd container the Player fills (see Editor.tsx) so
 * its percentage-based box lines up with the composition pixel-for-pixel
 * without any manual coordinate translation.
 *
 * Drag/resize is ephemeral local state during the gesture (matching
 * TimelineClip's pattern) and only becomes a real edit — one "setProp" op —
 * on release, so a quick unproductive drag doesn't spam the server.
 *
 * Multiple overlays selected at once: every selected box is shown, dragging
 * any one moves the whole group together (one "shiftOverlayBoxMany" op),
 * and resize handles are hidden entirely — each overlay has its own size
 * and aspect ratio, so "resize the group" isn't a single well-defined
 * action. Reselect just one to resize it.
 */

/** Smallest on-canvas box size, as a fraction of the composition — mirrors
 *  MIN_OVERLAY_SIZE in timelineOps.ts (the source of truth the server
 *  enforces regardless); kept here too so the box never visually inverts
 *  mid-drag before that clamp would apply. */
const MIN_SIZE = 0.03;

/** These wrap exactly one piece of media, so corner-drag preserves its
 *  natural aspect ratio. Text/composite cards resize freely. */
const ASPECT_LOCKED_COMPONENTS = new Set(["ImageOverlay", "VideoOverlay"]);

type Corner = "nw" | "ne" | "sw" | "se";
const CORNERS: { id: Corner; dirX: 1 | -1; dirY: 1 | -1; cursor: string }[] = [
  { id: "nw", dirX: -1, dirY: -1, cursor: "nwse-resize" },
  { id: "ne", dirX: 1, dirY: -1, cursor: "nesw-resize" },
  { id: "sw", dirX: -1, dirY: 1, cursor: "nesw-resize" },
  { id: "se", dirX: 1, dirY: 1, cursor: "nwse-resize" },
];

type Box = { x: number; y: number; width: number; height: number };

type DragState =
  | { kind: "move"; startClientX: number; startClientY: number; startBox: Box }
  | { kind: "groupMove"; startClientX: number; startClientY: number }
  | {
      kind: "resize";
      corner: Corner;
      startClientX: number;
      startClientY: number;
      /** The diagonally-opposite corner, in fraction space — stays fixed
       *  for the whole gesture; the box is rebuilt each move from this
       *  anchor plus the dragged corner's current position. */
      anchorX: number;
      anchorY: number;
      startFreeX: number;
      startFreeY: number;
      aspectRatio: number | null;
    };

/** Loads an image/video just to read its natural pixel aspect ratio — used
 *  only to lock corner-resize for media overlays. Free-resize components
 *  never call this. */
const useNaturalAspectRatio = (src: string | undefined, isVideo: boolean): number | null => {
  const [ratio, setRatio] = useState<number | null>(null);
  useEffect(() => {
    setRatio(null);
    if (!src) return;
    let cancelled = false;
    if (isVideo) {
      const video = document.createElement("video");
      video.onloadedmetadata = () => {
        if (!cancelled && video.videoHeight > 0) setRatio(video.videoWidth / video.videoHeight);
      };
      video.src = `/${src}`;
    } else {
      const img = new Image();
      img.onload = () => {
        if (!cancelled && img.naturalHeight > 0) setRatio(img.naturalWidth / img.naturalHeight);
      };
      img.src = `/${src}`;
    }
    return () => {
      cancelled = true;
    };
  }, [src, isVideo]);
  return ratio;
};

export function OverlayCanvas({
  edl,
  selection,
  currentTimeSec,
  onSelect,
  onOp,
}: {
  edl: Edl;
  selection: Selection;
  currentTimeSec: number;
  onSelect: (s: Selection) => void;
  onOp: (op: TimelineOp) => void;
}) {
  const selectedIds = selection?.track === "overlay" ? selection.ids : [];
  const isMulti = selectedIds.length > 1;
  const singleOverlay = selectedIds.length === 1 ? edl.overlays.find((o) => o.id === selectedIds[0]) : undefined;

  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [liveBox, setLiveBox] = useState<Box | null>(null);
  const [liveGroupDelta, setLiveGroupDelta] = useState<{ dxFrac: number; dyFrac: number } | null>(null);

  const aspectLocked = singleOverlay ? ASPECT_LOCKED_COMPONENTS.has(singleOverlay.component) : false;
  const src =
    singleOverlay && aspectLocked && typeof singleOverlay.params.src === "string"
      ? singleOverlay.params.src
      : undefined;
  const naturalAspect = useNaturalAspectRatio(src, singleOverlay?.component === "VideoOverlay");

  // Other overlays visible right now, behind the selection — clicking one
  // selects it (Shift adds it), matching CapCut's "click the element on
  // canvas" model rather than requiring the timeline for every change.
  const othersVisible = edl.overlays.filter(
    (o) => !selectedIds.includes(o.id) && currentTimeSec >= o.tlInSec && currentTimeSec < o.tlOutSec,
  );

  const selectOverlay = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    // Shift or Cmd/Ctrl — see TimelineClip's beginDrag for why both.
    onSelect(toggleSelect(selection, "overlay", id, e.shiftKey || e.metaKey || e.ctrlKey));
  };

  const renderClickableOverlay = (o: Edl["overlays"][number]) => (
    <div
      key={o.id}
      onClick={(e) => selectOverlay(o.id, e)}
      style={{
        position: "absolute",
        left: `${o.x * 100}%`,
        top: `${o.y * 100}%`,
        width: `${o.width * 100}%`,
        height: `${o.height * 100}%`,
      }}
      className="pointer-events-auto cursor-pointer hover:outline hover:outline-2 hover:outline-[color:var(--ed-accent)]/60"
    />
  );

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const dxFrac = (e.clientX - drag.startClientX) / rect.width;
    const dyFrac = (e.clientY - drag.startClientY) / rect.height;

    if (drag.kind === "groupMove") {
      setLiveGroupDelta({ dxFrac, dyFrac });
      return;
    }
    if (drag.kind === "move") {
      setLiveBox({ ...drag.startBox, x: drag.startBox.x + dxFrac, y: drag.startBox.y + dyFrac });
      return;
    }

    const corner = CORNERS.find((c) => c.id === drag.corner)!;
    const freeX = drag.startFreeX + dxFrac;
    let freeY = drag.startFreeY + dyFrac;
    if (drag.aspectRatio) {
      // Height is DERIVED from width in real pixels (fractions of width vs.
      // height are on different absolute scales — edl.width vs edl.height
      // — so the ratio has to be computed in pixel space, not fraction
      // space, or it would skew with the composition's own aspect ratio).
      const widthPx = Math.abs(freeX - drag.anchorX) * edl.width;
      const heightPx = widthPx / drag.aspectRatio;
      freeY = drag.anchorY + corner.dirY * (heightPx / edl.height);
    }
    const x = Math.min(drag.anchorX, freeX);
    const y = Math.min(drag.anchorY, freeY);
    const width = Math.max(Math.abs(freeX - drag.anchorX), MIN_SIZE);
    const height = Math.max(Math.abs(freeY - drag.anchorY), MIN_SIZE);
    setLiveBox({ x, y, width, height });
  };

  const endDrag = () => {
    if (!drag) return;
    if (drag.kind === "groupMove") {
      if (liveGroupDelta) {
        onOp({ type: "shiftOverlayBoxMany", ids: selectedIds, dx: liveGroupDelta.dxFrac, dy: liveGroupDelta.dyFrac });
      }
      setLiveGroupDelta(null);
    } else if (liveBox && singleOverlay) {
      onOp({
        type: "setProp",
        track: "overlay",
        id: singleOverlay.id,
        patch: { x: liveBox.x, y: liveBox.y, width: liveBox.width, height: liveBox.height },
      });
    }
    setDrag(null);
    setLiveBox(null);
  };

  const beginGroupMove = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({ kind: "groupMove", startClientX: e.clientX, startClientY: e.clientY });
  };

  if (isMulti) {
    return (
      <div ref={containerRef} className="pointer-events-none absolute inset-0">
        {othersVisible.map(renderClickableOverlay)}
        {selectedIds.map((id) => {
          const o = edl.overlays.find((ov) => ov.id === id);
          if (!o) return null;
          const dx = liveGroupDelta?.dxFrac ?? 0;
          const dy = liveGroupDelta?.dyFrac ?? 0;
          return (
            <div
              key={id}
              onPointerDown={beginGroupMove}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              style={{
                position: "absolute",
                left: `${(o.x + dx) * 100}%`,
                top: `${(o.y + dy) * 100}%`,
                width: `${o.width * 100}%`,
                height: `${o.height * 100}%`,
              }}
              className="pointer-events-auto cursor-grab border-2 border-[color:var(--ed-accent)] active:cursor-grabbing"
            />
          );
        })}
      </div>
    );
  }

  if (!singleOverlay) {
    if (othersVisible.length === 0) return null;
    return <div className="pointer-events-none absolute inset-0">{othersVisible.map(renderClickableOverlay)}</div>;
  }

  const box: Box = liveBox ?? {
    x: singleOverlay.x,
    y: singleOverlay.y,
    width: singleOverlay.width,
    height: singleOverlay.height,
  };

  const beginMove = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({ kind: "move", startClientX: e.clientX, startClientY: e.clientY, startBox: box });
  };

  const beginResize = (e: React.PointerEvent, corner: Corner) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const c = CORNERS.find((c) => c.id === corner)!;
    const anchorX = c.dirX === 1 ? box.x : box.x + box.width;
    const anchorY = c.dirY === 1 ? box.y : box.y + box.height;
    const startFreeX = c.dirX === 1 ? box.x + box.width : box.x;
    const startFreeY = c.dirY === 1 ? box.y + box.height : box.y;
    setDrag({
      kind: "resize",
      corner,
      startClientX: e.clientX,
      startClientY: e.clientY,
      anchorX,
      anchorY,
      startFreeX,
      startFreeY,
      aspectRatio: aspectLocked ? (naturalAspect ?? box.width / box.height) : null,
    });
  };

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0">
      {othersVisible.map(renderClickableOverlay)}
      <div
        onPointerDown={beginMove}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        style={{
          position: "absolute",
          left: `${box.x * 100}%`,
          top: `${box.y * 100}%`,
          width: `${box.width * 100}%`,
          height: `${box.height * 100}%`,
        }}
        className="pointer-events-auto cursor-grab border-2 border-[color:var(--ed-accent)] active:cursor-grabbing"
      >
        {CORNERS.map((c) => (
          <div
            key={c.id}
            onPointerDown={(e) => beginResize(e, c.id)}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            style={{
              position: "absolute",
              left: c.dirX === 1 ? "100%" : 0,
              top: c.dirY === 1 ? "100%" : 0,
              transform: "translate(-50%, -50%)",
              cursor: c.cursor,
            }}
            className="pointer-events-auto h-3.5 w-3.5 rounded-full border-2 border-[color:var(--ed-accent)] bg-white shadow-md"
          />
        ))}
      </div>
    </div>
  );
}

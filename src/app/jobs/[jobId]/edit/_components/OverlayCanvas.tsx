"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Edl, EdlCaptionGroup } from "@backend/pipeline/types";
import type { TimelineOp } from "@backend/pipeline/timelineOps";
import { Selection, toggleSelect } from "./selection";
import { TEXT_VARIANTS, TextVariant, defaultLowerThirdFontSize, fitDidoneFontSize } from "@backend/components/style";

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
      /** The box's own size when the drag began — resize scales font size
       *  by how much this grows/shrinks (see endDrag), so it has to be
       *  captured once at gesture start, not re-derived from anchor/free
       *  corners (which move as the drag progresses). Only set for a
       *  TextOverlay resize — image/video overlays don't carry a font. */
      startBox?: Box;
      startFontSize?: number;
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

/**
 * The selected caption group's own move + resize box on the preview.
 *
 * Move is a plain drag, same as an overlay. Resize is different from an
 * overlay's: a caption group has no box of its own (schema-wise) — its
 * size comes from its text, theme and variant (Captions.tsx) — so
 * dragging a corner here doesn't write a width/height at all, it scales
 * the group's own `fontSize` override (see EdlCaptionGroupSchema) by how
 * much the box grew/shrank, then lets Captions.tsx re-render at that size
 * and this component re-measure the result next frame. "Captions and text
 * are the same thing" — this is the same font-scale-on-resize gesture
 * OverlayCanvas's own beginResize/endDrag give a TextOverlay.
 *
 * The box is MEASURED from the caption node the Player actually rendered
 * (Captions.tsx tags each group with data-caption-group) rather than
 * re-derived from font metrics in the editor. Re-deriving would mean a
 * second copy of the renderer's layout math — font stack, per-theme size,
 * word margins, wrapping — that silently drifts from the real thing the
 * first time either side changes. Measuring can't drift; only the ONE
 * NUMBER a resize gesture needs before any measurement exists yet (the
 * starting font size, to scale from) is computed from the same constants
 * Captions.tsx itself falls back to (see effectiveFontSize below) rather
 * than measured, since there's nothing on screen to measure until a
 * fontSize is actually set.
 */
const CaptionMoveBox = ({
  group,
  containerRef,
  onOp,
  frameWidth,
  frameHeight,
}: {
  group: EdlCaptionGroup;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onOp: (op: TimelineOp) => void;
  frameWidth: number;
  frameHeight: number;
}) => {
  const [box, setBox] = useState<Box | null>(null);
  const [delta, setDelta] = useState<{ dx: number; dy: number } | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [resizeDrag, setResizeDrag] = useState<{
    corner: Corner;
    startClientX: number;
    startClientY: number;
    anchorX: number;
    anchorY: number;
    startFreeX: number;
    startFreeY: number;
    aspectRatio: number;
    startFontSize: number;
  } | null>(null);
  const [liveResizeBox, setLiveResizeBox] = useState<Box | null>(null);

  /** The size this group is ACTUALLY rendering at right now — its own
   *  fontSize override, or the same default Captions.tsx itself falls
   *  back to for its variant/theme (see style.ts). The baseline a resize
   *  drag scales up or down from. */
  const effectiveFontSize =
    group.fontSize ??
    (group.variant === "bigTitle"
      ? fitDidoneFontSize(group.words[0]?.text ?? "", frameWidth, frameHeight)
      : defaultLowerThirdFontSize(group.theme));

  // Re-measured every frame: the active-word highlight scales words as the
  // playhead moves, so the line's real bounds change continuously and a
  // one-shot measurement would leave the box lagging behind the text. The
  // equality check keeps that from turning into a render every frame — the
  // state only actually changes when the measured geometry does.
  useLayoutEffect(() => {
    let raf = 0;
    const measure = () => {
      raf = requestAnimationFrame(measure);
      const container = containerRef.current;
      const node = container?.parentElement?.querySelector(`[data-caption-group="${group.id}"]`);
      if (!container || !node) {
        setBox((prev) => (prev === null ? prev : null));
        return;
      }
      const base = container.getBoundingClientRect();
      if (base.width === 0 || base.height === 0) return;
      const rect = node.getBoundingClientRect();
      const next: Box = {
        x: (rect.left - base.left) / base.width,
        y: (rect.top - base.top) / base.height,
        width: rect.width / base.width,
        height: rect.height / base.height,
      };
      setBox((prev) =>
        prev &&
        Math.abs(prev.x - next.x) < 1e-4 &&
        Math.abs(prev.y - next.y) < 1e-4 &&
        Math.abs(prev.width - next.width) < 1e-4 &&
        Math.abs(prev.height - next.height) < 1e-4
          ? prev
          : next,
      );
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [group.id, containerRef]);

  if (!box) return null;

  const dx = delta?.dx ?? 0;
  const dy = delta?.dy ?? 0;
  // While resizing, the drawn box previews the live drag; the actual text
  // doesn't visually grow until the gesture commits and Captions.tsx
  // re-renders at the new fontSize — same "box previews, content updates
  // on release" contract OverlayCanvas's own overlay resize already uses.
  const drawnBox = liveResizeBox ?? box;

  const beginCaptionResize = (e: React.PointerEvent, corner: Corner) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const c = CORNERS.find((cc) => cc.id === corner)!;
    setResizeDrag({
      corner,
      startClientX: e.clientX,
      startClientY: e.clientY,
      anchorX: c.dirX === 1 ? box.x : box.x + box.width,
      anchorY: c.dirY === 1 ? box.y : box.y + box.height,
      startFreeX: c.dirX === 1 ? box.x + box.width : box.x,
      startFreeY: c.dirY === 1 ? box.y + box.height : box.y,
      // A caption's fontSize is one number, so corner drag always
      // preserves the box's own starting aspect ratio — never a free,
      // non-uniform stretch (unlike an overlay's free-resizing text box).
      aspectRatio: box.width / box.height,
      startFontSize: effectiveFontSize,
    });
  };

  const onCaptionResizeMove = (e: React.PointerEvent) => {
    if (!resizeDrag) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const dxFrac = (e.clientX - resizeDrag.startClientX) / rect.width;
    const corner = CORNERS.find((c) => c.id === resizeDrag.corner)!;
    const freeX = resizeDrag.startFreeX + dxFrac;
    // Height derived from width in pixel space (see OverlayCanvas's own
    // aspect-locked resize for why fraction space alone would skew this).
    const widthPx = Math.abs(freeX - resizeDrag.anchorX) * frameWidth;
    const heightPx = widthPx / resizeDrag.aspectRatio;
    const freeY = resizeDrag.anchorY + corner.dirY * (heightPx / frameHeight);
    const x = Math.min(resizeDrag.anchorX, freeX);
    const y = Math.min(resizeDrag.anchorY, freeY);
    setLiveResizeBox({
      x,
      y,
      width: Math.max(Math.abs(freeX - resizeDrag.anchorX), MIN_SIZE),
      height: Math.max(Math.abs(freeY - resizeDrag.anchorY), MIN_SIZE),
    });
  };

  const endCaptionResize = () => {
    if (!resizeDrag) return;
    if (liveResizeBox) {
      const scale = liveResizeBox.width / box.width;
      onOp({
        type: "setProp",
        track: "captions",
        id: group.id,
        patch: {
          x: liveResizeBox.x + liveResizeBox.width / 2,
          y: liveResizeBox.y + liveResizeBox.height / 2,
          fontSize: Math.max(8, Math.round(resizeDrag.startFontSize * scale)),
        },
      });
    }
    setResizeDrag(null);
    setLiveResizeBox(null);
  };

  return (
    <div
      onPointerDown={(e) => {
        e.stopPropagation();
        (e.target as Element).setPointerCapture(e.pointerId);
        dragStart.current = { x: e.clientX, y: e.clientY };
        setDelta({ dx: 0, dy: 0 });
      }}
      onPointerMove={(e) => {
        const start = dragStart.current;
        const container = containerRef.current;
        if (!start || !container) return;
        const base = container.getBoundingClientRect();
        setDelta({ dx: (e.clientX - start.x) / base.width, dy: (e.clientY - start.y) / base.height });
      }}
      onPointerUp={() => {
        // Commit the box's CENTER — the anchor Captions.tsx positions a
        // hand-placed group from — and only for a drag that actually
        // moved, so a stray click doesn't pin a caption that was happily
        // laying out automatically.
        if (dragStart.current && delta && (delta.dx !== 0 || delta.dy !== 0)) {
          onOp({
            type: "setProp",
            track: "captions",
            id: group.id,
            patch: { x: box.x + box.width / 2 + delta.dx, y: box.y + box.height / 2 + delta.dy },
          });
        }
        dragStart.current = null;
        setDelta(null);
      }}
      style={{
        position: "absolute",
        left: `${(drawnBox.x + dx) * 100}%`,
        top: `${(drawnBox.y + dy) * 100}%`,
        width: `${drawnBox.width * 100}%`,
        height: `${drawnBox.height * 100}%`,
      }}
      className="pointer-events-auto cursor-grab border-2 border-dashed border-[color:var(--ed-accent)] active:cursor-grabbing"
    >
      {CORNERS.map((c) => (
        <div
          key={c.id}
          onPointerDown={(e) => beginCaptionResize(e, c.id)}
          onPointerMove={onCaptionResizeMove}
          onPointerUp={endCaptionResize}
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
  );
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

  // A single selected caption group, and only while it's actually on screen
  // — there's nothing to measure or drag at a time the group doesn't render.
  const selectedCaption =
    selection?.track === "captions" && selection.ids.length === 1
      ? edl.captions.find(
          (c) => c.id === selection.ids[0] && currentTimeSec >= c.tlInSec && currentTimeSec < c.tlOutSec,
        )
      : undefined;

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

  const isTextOverlay = singleOverlay?.component === "TextOverlay";
  /** The size a TextOverlay is ACTUALLY rendering at right now — its own
   *  params.fontSize override if it has one, else the variant's house
   *  default (see TEXT_VARIANTS) — the baseline a resize drag scales up
   *  or down from. */
  const effectiveFontSize = (o: Edl["overlays"][number]): number => {
    const variant = (typeof o.params.variant === "string" ? o.params.variant : "hook") as TextVariant;
    const fallback = (TEXT_VARIANTS[variant] ?? TEXT_VARIANTS.hook).fontSize;
    return typeof o.params.fontSize === "number" ? o.params.fontSize : fallback;
  };

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
      const patch: Record<string, unknown> = { x: liveBox.x, y: liveBox.y, width: liveBox.width, height: liveBox.height };
      // Corner-resizing a text box scales its font size along with the
      // box, the same "drag the handle, the text gets bigger" gesture
      // CapCut uses — derived from how much the box's own area changed
      // (geometric mean of the width/height ratios, so a uniform corner
      // drag scales cleanly and a stretched one still lands on a sensible
      // single number) rather than a separate, disconnected control.
      if (drag.kind === "resize" && drag.startBox && drag.startFontSize) {
        const widthRatio = liveBox.width / drag.startBox.width;
        const heightRatio = liveBox.height / drag.startBox.height;
        const scale = Math.sqrt(widthRatio * heightRatio);
        patch.params = { fontSize: Math.max(8, Math.round(drag.startFontSize * scale)) };
      }
      onOp({
        type: "setProp",
        track: "overlay",
        id: singleOverlay.id,
        patch,
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

  if (selectedCaption) {
    return (
      <div ref={containerRef} className="pointer-events-none absolute inset-0">
        {othersVisible.map(renderClickableOverlay)}
        <CaptionMoveBox
          group={selectedCaption}
          containerRef={containerRef}
          onOp={onOp}
          frameWidth={edl.width}
          frameHeight={edl.height}
        />
      </div>
    );
  }

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
    const startFontSize = isTextOverlay ? effectiveFontSize(singleOverlay!) : undefined;
    setDrag({
      kind: "resize",
      corner,
      startClientX: e.clientX,
      startClientY: e.clientY,
      anchorX,
      anchorY,
      startFreeX,
      startFreeY,
      startBox: isTextOverlay ? box : undefined,
      startFontSize,
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

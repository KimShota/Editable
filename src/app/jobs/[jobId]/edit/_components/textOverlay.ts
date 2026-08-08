import type { TimelineOp } from "@backend/pipeline/timelineOps";

/** Custom drag-and-drop payload marking "the Add Text button is what's
 *  being dragged" — lets the preview canvas and the timeline tell this
 *  apart from an OS file drag (which MediaPanel's own AddButton already
 *  handles via dataTransfer.files) using only dataTransfer.types, which is
 *  all a dragover handler can see before drop. */
export const TEXT_OVERLAY_DRAG_TYPE = "application/x-editable-text-overlay";

const DEFAULT_WIDTH = 0.6;
const DEFAULT_HEIGHT = 0.18;
const DEFAULT_DURATION_SEC = 3;

/** Builds the "addOverlay" op for a brand-new TextOverlay, sized around a
 *  center point — the drop position on the preview, or the frame's own
 *  center for a plain click or a timeline drop (which has a time but no
 *  x/y) — and clamped so the box never hangs off the edge. */
export const buildAddTextOverlayOp = (
  tlInSec: number,
  center: { x: number; y: number } = { x: 0.5, y: 0.5 },
): TimelineOp => {
  const width = DEFAULT_WIDTH;
  const height = DEFAULT_HEIGHT;
  const x = Math.min(Math.max(center.x - width / 2, 0), 1 - width);
  const y = Math.min(Math.max(center.y - height / 2, 0), 1 - height);
  const tlIn = Math.max(0, tlInSec);
  return {
    type: "addOverlay",
    component: "TextOverlay",
    text: "Text",
    tlInSec: tlIn,
    tlOutSec: tlIn + DEFAULT_DURATION_SEC,
    x,
    y,
    width,
    height,
  };
};

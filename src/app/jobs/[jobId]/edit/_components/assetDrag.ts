import type { DragFamily } from "./dropTarget";
import { TEXT_OVERLAY_DRAG_TYPE } from "./textOverlay";

/**
 * HTML5 drag-and-drop payload for a card dragged out of the media library
 * onto the timeline: the asset is already staged (it's in edl.assets
 * because it's already on the timeline somewhere), so a drop just adds a
 * NEW instance of it via an ordinary add* op — no upload round trip,
 * exactly like dragging the same clip out of CapCut's media pool twice.
 */
export const ASSET_DRAG_TYPE = "application/x-editable-asset";

/** A dragover handler can't read dataTransfer's DATA, only its `types` —
 *  so the two things live drop feedback needs (which family of track this
 *  wants, and how long it is, for the overlap check) are smuggled into a
 *  second type string of their own. */
const META_PREFIX = "application/x-editable-asset-meta;";

export type AssetDragPayload =
  | {
      kind: "video";
      src: string;
      srcInSec: number;
      durationSec: number;
      srcDurationSec?: number;
    }
  | {
      kind: "image";
      src: string;
      durationSec: number;
      box: { x: number; y: number; width: number; height: number };
    }
  | { kind: "music" | "sfx"; src: string; durationSec?: number };

export const assetFamily = (p: AssetDragPayload): DragFamily =>
  p.kind === "video" ? "video" : p.kind === "image" ? "overlay" : p.kind;

export const setAssetDragData = (dt: DataTransfer, payload: AssetDragPayload): void => {
  dt.effectAllowed = "copy";
  dt.setData(ASSET_DRAG_TYPE, JSON.stringify(payload));
  dt.setData(
    `${META_PREFIX}family=${assetFamily(payload)};duration=${payload.durationSec ?? 0}`,
    "1",
  );
};

export const readAssetDragData = (dt: DataTransfer): AssetDragPayload | null => {
  const raw = dt.getData(ASSET_DRAG_TYPE);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AssetDragPayload;
  } catch {
    return null;
  }
};

/** What's being dragged over the timeline, from nothing but what a
 *  dragover event is allowed to see. Null for a drag the timeline doesn't
 *  accept (plain text, a link). A desktop file's family comes from its
 *  MIME type when the browser exposes it mid-drag (Chrome/Firefox do), and
 *  falls back to footage otherwise — the drop handler re-resolves from the
 *  real file either way, so the fallback only ever affects the preview. */
export const dragFamilyFromTransfer = (
  dt: DataTransfer,
): { family: DragFamily; durationSec: number } | null => {
  const types = Array.from(dt.types);
  if (types.includes(TEXT_OVERLAY_DRAG_TYPE)) return { family: "text", durationSec: 3 };
  const meta = types.find((t) => t.startsWith(META_PREFIX));
  if (meta) {
    const fields = Object.fromEntries(
      meta
        .slice(META_PREFIX.length)
        .split(";")
        .map((kv) => kv.split("=") as [string, string]),
    );
    const family = fields.family as DragFamily | undefined;
    if (family) return { family, durationSec: Number(fields.duration) || 0 };
  }
  if (types.includes("Files")) {
    const mime = dt.items?.[0]?.type ?? "";
    return { family: fileFamily(mime), durationSec: 0 };
  }
  return null;
};

/** Which family a desktop file belongs to, from its MIME type. Unknown
 *  types are treated as footage — the upload route rejects anything it
 *  can't actually probe, so a wrong guess here costs one error message,
 *  not a mis-placed clip. */
export const fileFamily = (mime: string): DragFamily =>
  mime.startsWith("audio/") ? "music" : mime.startsWith("image/") ? "overlay" : "video";

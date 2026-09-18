import type { TrackKind } from "@backend/pipeline/timelineOps";

/**
 * Where a dragged thing lands on the timeline — the one set of rules
 * behind every drop, whether it's a clip already on the timeline being
 * dragged to another row, a card dragged out of the media library, a file
 * dragged in from the desktop, or the Text tab's "Add text" button. All
 * four gestures reduce to the same three inputs (what's being dragged,
 * which row the pointer is over, where in time it is) and get the same
 * answer back, so the timeline behaves identically no matter where the
 * asset came from. CapCut's rules, exactly:
 *
 *  - The MAIN track is magnetic and video-only. Footage dropped on it is
 *    INSERTED at the cut nearest the drop (never stacked, never leaving a
 *    gap); anything that isn't footage goes to a fresh track of its own
 *    kind instead.
 *  - A row of the SAME kind as the asset accepts it — unless the asset
 *    would overlap a clip already on that row, in which case it gets a
 *    fresh row of that kind. Secondary layers may overlap each OTHER in
 *    time (that's what picture-in-picture is); clips on ONE layer never
 *    overlap.
 *  - A row of a DIFFERENT kind never accepts it: the drop is intercepted
 *    and a fresh track of the asset's own kind is created.
 *  - Blank space (no row under the pointer at all) creates a fresh track
 *    of the asset's kind.
 *
 * Pure: no DOM, no React — the caller hit-tests the pointer against its
 * own rows and hands the result in.
 */

/** Which family of track the dragged thing can live on. `video` means
 *  footage: the one kind that can go on EITHER the main track or a
 *  picture-in-picture (`overlay`-kind) layer. Every other family maps 1:1
 *  onto a TrackKind. */
export type DragFamily = "video" | "overlay" | "text" | "captions" | "music" | "sfx";

export type DragPayload = {
  family: DragFamily;
  /** How long the thing is, for the overlap check. 0 for something whose
   *  length isn't known yet (a file still on the desktop) — then only a
   *  drop INSIDE an existing clip counts as overlapping it. */
  durationSec: number;
  /** The dragged clip's own id, when it's already on the timeline — so it
   *  isn't counted as overlapping itself when dropped back where it was. */
  selfId?: string;
};

/** Which row the pointer ended up over. */
export type RowHit = { kind: "main" } | { kind: TrackKind; trackId: string } | null;

export type DropTarget =
  /** Insert into the main reel before the clip currently at `index`
   *  (`index === length` appends). */
  | { kind: "main"; index: number; tlInSec: number }
  /** Onto an existing free-floating track. */
  | { kind: TrackKind; trackId: string; newTrack?: undefined; tlInSec: number }
  /** Onto a brand-new track of this kind. */
  | { kind: TrackKind; newTrack: true; trackId?: undefined; tlInSec: number };

export type Interval = { id: string; tlInSec: number; tlOutSec: number };

/** The kind of track a non-main drop of this family lands on. */
export const floatKindFor = (family: DragFamily): TrackKind =>
  family === "video" ? "overlay" : family;

/** Every cut on the main reel a clip can be inserted at — t=0 plus each
 *  clip's out-point — for the given sequence. `index` i in the result is
 *  the insertion index that puts the new clip before clip i. */
export const mainCuts = (clips: { tlOutSec: number }[]): number[] => [
  0,
  ...clips.map((c) => c.tlOutSec),
];

/** The insertion index whose cut is closest to `sec`. Ties go to the
 *  earlier cut. */
export const nearestCutIndex = (cuts: number[], sec: number): number => {
  let best = 0;
  let bestDist = Infinity;
  cuts.forEach((cut, i) => {
    const dist = Math.abs(cut - sec);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
};

export const overlaps = (
  a: { tlInSec: number; tlOutSec: number },
  b: { tlInSec: number; tlOutSec: number },
): boolean => a.tlInSec < b.tlOutSec - 1e-6 && a.tlOutSec > b.tlInSec + 1e-6;

export const resolveDropTarget = ({
  payload,
  row,
  tlInSec,
  clipsOnTrack,
  mainClips,
}: {
  payload: DragPayload;
  row: RowHit;
  /** Where the dragged thing's leading edge is, in timeline seconds. */
  tlInSec: number;
  /** Every clip currently on a given free-floating track. */
  clipsOnTrack: (trackId: string) => Interval[];
  /** The main reel as it stands, minus the dragged clip itself if it's
   *  one of them — insertion is computed against what would remain. */
  mainClips: { id: string; tlOutSec: number }[];
}): DropTarget => {
  const start = Math.max(0, tlInSec);
  const floatKind = floatKindFor(payload.family);

  if (row?.kind === "main") {
    if (payload.family === "video") {
      const remaining = mainClips.filter((c) => c.id !== payload.selfId);
      return { kind: "main", index: nearestCutIndex(mainCuts(remaining), start), tlInSec: start };
    }
    return { kind: floatKind, newTrack: true, tlInSec: start };
  }

  if (row && row.kind === floatKind) {
    const self = { tlInSec: start, tlOutSec: start + payload.durationSec };
    const collides = clipsOnTrack(row.trackId).some(
      (c) =>
        c.id !== payload.selfId &&
        (payload.durationSec > 0
          ? overlaps(self, c)
          : c.tlInSec < start - 1e-6 && c.tlOutSec > start + 1e-6),
    );
    if (!collides) return { kind: floatKind, trackId: row.trackId, tlInSec: start };
  }

  return { kind: floatKind, newTrack: true, tlInSec: start };
};

/** A stable string for a target — so live drop feedback only re-renders
 *  the track rows when the answer actually changes, not on every pointer
 *  move. Time is deliberately left out: it changes on every pixel and the
 *  rows don't draw it (the insertion marker is drawn separately). */
export const dropTargetKey = (t: DropTarget | null): string | null => {
  if (!t) return null;
  if (t.kind === "main") return `main:${t.index}`;
  return t.newTrack ? `${t.kind}:new` : `${t.kind}:${t.trackId}`;
};

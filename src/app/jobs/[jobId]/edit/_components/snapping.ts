/**
 * Magnetic alignment for timeline drags — the pull half of the toolbar's
 * magnet toggle, and the evidence (a snap guide) that goes with it.
 *
 * A drag reports the raw pixels the pointer traveled; this decides whether
 * one of the moving edges lands close enough to a fixed point of interest —
 * another clip's boundary, the playhead, the start or end of the video — to
 * be pulled onto it exactly. When it does, the caller gets back both the
 * corrected delta (so the clip visually locks on, and commits at the pulled
 * position rather than wherever the pointer happened to stop) and the second
 * it locked onto, which is what the green guide line is drawn at.
 *
 * The threshold is in PIXELS, not seconds, on purpose: "close enough to mean
 * the same thing" is a property of what the eye can resolve at the current
 * zoom, so the same 8px feels right whether a pixel is a frame or a minute.
 */

/** How near an edge has to come, on screen, before it's pulled in. Wide
 *  enough that a normal drag finds the alignment without aiming for it,
 *  narrow enough that landing NEXT to a boundary on purpose still works —
 *  and at max zoom it's under a frame, so it never fights frame-accurate
 *  work. */
export const SNAP_THRESHOLD_PX = 8;

/** One fixed point a dragged edge can be pulled onto. `key` identifies the
 *  clip it came from (`track:id`) so a clip's own boundaries can be left out
 *  of its own drag — otherwise every clip would snap to where it already is
 *  and never move. Non-clip points (the playhead, the timeline's start/end)
 *  use their own reserved keys. */
export type SnapTarget = { sec: number; key: string };

export type SnapResult = {
  /** The raw delta, corrected onto the target when one was in range. */
  deltaPx: number;
  /** The second the guide line is drawn at, or null when nothing was hit. */
  guideSec: number | null;
};

/** Both boundaries of every clip in one track, keyed by track so a
 *  transition (which is identified by the id of the clip it follows) can't
 *  be confused with that video clip itself. */
export function clipEdgeTargets(
  clips: { id: string; tlInSec: number; tlOutSec: number; track?: string }[],
  track: string,
): SnapTarget[] {
  return clips.flatMap((c) => {
    const key = `${c.track ?? track}:${c.id}`;
    return [
      { sec: c.tlInSec, key },
      { sec: c.tlOutSec, key },
    ];
  });
}

/**
 * Pull `edgesSec` (a drag's moving edge, or every edge of a group being
 * moved together) onto the nearest target within threshold.
 *
 * Every moving edge is tested against every target and the single closest
 * pairing wins — so dragging a clip toward a cut latches by whichever of its
 * head or tail arrives first, which is what makes butting two clips together
 * feel automatic from either direction.
 */
export function resolveSnap({
  targets,
  edgesSec,
  excludeKeys,
  rawDeltaPx,
  pxPerSec,
  thresholdPx = SNAP_THRESHOLD_PX,
}: {
  targets: SnapTarget[];
  edgesSec: number[];
  /** Keys (`track:id`) of the clips being dragged — their own boundaries
   *  travel with the drag, so they can't act as fixed points for it. */
  excludeKeys: string[];
  rawDeltaPx: number;
  pxPerSec: number;
  thresholdPx?: number;
}): SnapResult {
  const rawDeltaSec = rawDeltaPx / pxPerSec;
  let bestDistPx = thresholdPx;
  let best: { adjustPx: number; sec: number } | null = null;

  for (const target of targets) {
    if (excludeKeys.includes(target.key)) continue;
    for (const edge of edgesSec) {
      const distPx = Math.abs(target.sec - (edge + rawDeltaSec)) * pxPerSec;
      // Strictly nearer, so of two equally close targets the first listed
      // wins and the choice stays stable frame to frame instead of
      // flickering between them mid-drag.
      if (distPx < bestDistPx) {
        bestDistPx = distPx;
        best = { adjustPx: (target.sec - (edge + rawDeltaSec)) * pxPerSec, sec: target.sec };
      }
    }
  }

  if (!best) return { deltaPx: rawDeltaPx, guideSec: null };
  return { deltaPx: rawDeltaPx + best.adjustPx, guideSec: best.sec };
}

/** The same pull, for a point that isn't a drag delta — the playhead being
 *  scrubbed. Returns the second to actually seek to, plus the guide. */
export function snapPoint({
  targets,
  sec,
  pxPerSec,
  thresholdPx = SNAP_THRESHOLD_PX,
}: {
  targets: SnapTarget[];
  sec: number;
  pxPerSec: number;
  thresholdPx?: number;
}): { sec: number; guideSec: number | null } {
  let bestDistPx = thresholdPx;
  let best: number | null = null;
  for (const target of targets) {
    const distPx = Math.abs(target.sec - sec) * pxPerSec;
    if (distPx < bestDistPx) {
      bestDistPx = distPx;
      best = target.sec;
    }
  }
  return best === null ? { sec, guideSec: null } : { sec: best, guideSec: best };
}

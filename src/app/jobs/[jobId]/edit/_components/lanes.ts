export type LaneItem = { id: string; tlInSec: number; tlOutSec: number };

/**
 * Greedy interval partitioning: sorts clips by start time and drops each
 * one into the lowest-numbered lane whose last-placed clip has already
 * ended, opening a new lane otherwise. Lets overlapping clips within the
 * same track stack onto separate rows instead of drawing on top of each
 * other. Tracks that never overlap by construction (video, transitions,
 * music) just collapse to a single lane.
 */
export const assignLanes = (clips: LaneItem[]): Map<string, number> => {
  const sorted = [...clips].sort((a, b) => a.tlInSec - b.tlInSec);
  const laneEnds: number[] = [];
  const lanes = new Map<string, number>();
  for (const clip of sorted) {
    let lane = laneEnds.findIndex((end) => end <= clip.tlInSec + 1e-6);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(clip.tlOutSec);
    } else {
      laneEnds[lane] = clip.tlOutSec;
    }
    lanes.set(clip.id, lane);
  }
  return lanes;
};

export const laneCount = (lanes: Map<string, number>): number =>
  lanes.size === 0 ? 1 : Math.max(1, ...Array.from(lanes.values()).map((l) => l + 1));

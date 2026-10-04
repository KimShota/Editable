import type { Edl } from "@backend/pipeline/types";

/**
 * The generated voice lines (edl.voiceovers). A line has the position it was
 * generated at (`original`): the talking clips are lip-synced to it, so the
 * editor says when a line has moved off it and offers to put it back.
 */

export type VoiceLine = Edl["voiceovers"][number];

const EPS = 1e-3;

/** True when the line, or the part of its take that plays, is not what was generated. */
export const voiceMoved = (v: VoiceLine): boolean =>
  v.original !== undefined &&
  (Math.abs(v.tlInSec - v.original.tlInSec) > EPS ||
    Math.abs(v.tlOutSec - v.original.tlOutSec) > EPS ||
    Math.abs(v.srcInSec - v.original.srcInSec) > EPS ||
    Math.abs(v.srcOutSec - v.original.srcOutSec) > EPS);

/** What the line says: the caption words that start inside it (the EDL carries no script text), or its id.
 *  Read at the position it was generated at, so moving the line does not change what it is called. */
export const voiceText = (edl: Edl, v: VoiceLine): string => {
  const from = v.original?.tlInSec ?? v.tlInSec;
  const to = v.original?.tlOutSec ?? v.tlOutSec;
  const said = edl.captions
    .flatMap((c) => c.words)
    .filter((w) => w.tlStartSec >= from - 0.05 && w.tlStartSec < to)
    .map((w) => w.text)
    .join(" ");
  return said || v.blockId;
};

/** "0.4 s later than generated", "1.2 s earlier", or null when it starts where it was generated. */
export const voiceOffsetLabel = (v: VoiceLine): string | null => {
  if (!v.original) return null;
  const d = v.tlInSec - v.original.tlInSec;
  if (Math.abs(d) <= EPS) return null;
  return `${Math.abs(d).toFixed(2)} s ${d > 0 ? "later" : "earlier"} than generated`;
};

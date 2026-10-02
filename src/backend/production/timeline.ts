import type { AdaptedScript, RecreationSpec } from "../recreation/schemas";
import type { TimedWord } from "../voice/elevenlabs";

/**
 * The adapted video's timeline. Rin's lines are re-voiced, so they run
 * longer or shorter than the source's; the source's cuts are kept where
 * they fall RELATIVE TO THE SPEECH. A cut 40% of the way through a source
 * line lands 40% of the way through the new line; a cut in a pause lands
 * at the same point of the new pause. So the edit keeps the source's
 * rhythm (cut on the word, not on the clock) whatever the new durations.
 */

export type VoicedLine = { index: number; durationSec: number; words: TimedWord[] };

export type Timeline = {
  durationSec: number;
  lines: { index: number; tlInSec: number; tlOutSec: number; words: { text: string; tlStartSec: number; tlEndSec: number }[] }[];
  shots: { shotId: string; tlInSec: number; tlOutSec: number }[];
};

/** Pauses between lines keep the source's length, within limits that stop a
 *  long source pause from becoming dead air or a breathless run-on. */
const MIN_GAP = 0.08;
const MAX_GAP = 0.4;
const MIN_TAIL = 0.4;
const MAX_TAIL = 1.2;
/** Shorter than this, a shot reads as a glitch rather than a cut. */
export const MIN_SHOT_SEC = 0.5;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export const buildTimeline = (script: AdaptedScript, spec: RecreationSpec, voiced: VoicedLine[]): Timeline => {
  const src = spec.speech.lines;
  if (voiced.length !== src.length) throw new Error(`timeline: ${voiced.length} voiced lines for ${src.length} source lines`);
  const byIndex = new Map(voiced.map((v) => [v.index, v]));

  // Place the new lines: the source's lead-in, then each line's new length
  // and the source's (clamped) pause before the next.
  const lines: Timeline["lines"] = [];
  let t = clamp(src[0].startSec, 0, MAX_GAP);
  src.forEach((s, i) => {
    const v = byIndex.get(i);
    if (!v) throw new Error(`timeline: line ${i} was not voiced`);
    if (i > 0) t += clamp(s.startSec - src[i - 1].endSec, MIN_GAP, MAX_GAP);
    lines.push({ index: i, tlInSec: t, tlOutSec: t + v.durationSec, words: v.words.map((w) => ({ text: w.text, tlStartSec: t + w.startSec, tlEndSec: t + w.endSec })) });
    t += v.durationSec;
  });
  const lastSrc = src[src.length - 1];
  const durationSec = t + clamp(spec.media.durationSec - lastSrc.endSec, MIN_TAIL, MAX_TAIL);

  // Source time → new time, piecewise linear through matching anchors:
  // every line's start and end, plus the two ends of the video.
  const anchors: [number, number][] = [[0, 0]];
  src.forEach((s, i) => anchors.push([s.startSec, lines[i].tlInSec], [s.endSec, lines[i].tlOutSec]));
  anchors.push([spec.media.durationSec, durationSec]);
  const map = (x: number): number => {
    for (let k = 1; k < anchors.length; k++) {
      const [x0, y0] = anchors[k - 1];
      const [x1, y1] = anchors[k];
      if (x <= x1) return x1 === x0 ? y1 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
    return durationSec;
  };

  // Map every cut, then push apart any two that ended up too close.
  const cuts = spec.shots.slice(1).map((s) => map(s.startSec));
  for (let k = 0; k < cuts.length; k++) {
    const prev = k === 0 ? 0 : cuts[k - 1];
    cuts[k] = Math.max(cuts[k], prev + MIN_SHOT_SEC);
  }
  for (let k = cuts.length - 1; k >= 0; k--) {
    const next = k === cuts.length - 1 ? durationSec : cuts[k + 1];
    cuts[k] = Math.min(cuts[k], next - MIN_SHOT_SEC);
  }
  const edges = [0, ...cuts, durationSec];
  const shots = script.shots.map((s, i) => ({ shotId: s.shotId, tlInSec: edges[i], tlOutSec: edges[i + 1] }));
  if (shots.some((s) => s.tlOutSec - s.tlInSec < MIN_SHOT_SEC - 1e-9)) {
    throw new Error(`timeline: ${shots.length} shots do not fit in ${durationSec.toFixed(1)}s at ${MIN_SHOT_SEC}s each`);
  }
  return { durationSec, lines, shots };
};

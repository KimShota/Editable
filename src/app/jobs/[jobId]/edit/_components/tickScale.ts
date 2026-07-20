/** Labeled major ticks stay at least this many px apart at any zoom. */
export const MIN_MAJOR_LABEL_PX = 68;

/**
 * The ruler's granularity ladder, CapCut-style: as you zoom in, labels get
 * more precise (whole seconds → tenths → individual frames); as you zoom
 * out, they get more abstract (seconds → 10s → minutes). Built once per
 * fps — every step past the first six is frame-count-independent, the
 * first six are exact frame multiples so the finest zoom always lands on
 * real frame boundaries.
 */
export const buildMajorLadder = (fps: number): number[] => {
  const frame = 1 / fps;
  const fine = [1, 2, 5, 10, 15, 30].map((n) => n * frame);
  const coarse = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
  return Array.from(new Set([...fine, ...coarse])).sort((a, b) => a - b);
};

/** Picks the major tick interval (label spacing) and the minor tick
 *  interval (unlabeled subdivisions) for the current zoom level. */
export const chooseTickScale = (
  pxPerSec: number,
  fps: number,
  ladder: number[],
): { majorSec: number; minorSec: number; useFrames: boolean } => {
  const majorSec = ladder.find((s) => s * pxPerSec >= MIN_MAJOR_LABEL_PX) ?? ladder[ladder.length - 1];
  const frameSec = 1 / fps;
  let minorSec = majorSec / 5;
  if (minorSec < frameSec) minorSec = frameSec;
  if (minorSec >= majorSec) minorSec = 0; // already at 1-frame granularity — no finer subdivision
  return { majorSec, minorSec, useFrames: majorSec < 1 - 1e-9 };
};

/** Converts through integer frame counts so labels never drift from
 *  floating-point rounding — e.g. 0.5999999s never renders as "frame 30"
 *  when it should be "0:01:00". */
export const formatTick = (sec: number, useFrames: boolean, fps: number): string => {
  const totalFrames = Math.round(Math.max(0, sec) * fps);
  const wholeSec = Math.floor(totalFrames / fps);
  const frame = totalFrames - wholeSec * fps;
  const m = Math.floor(wholeSec / 60);
  const s = wholeSec - m * 60;
  const base = `${m}:${String(s).padStart(2, "0")}`;
  return useFrames ? `${base}:${String(frame).padStart(2, "0")}` : base;
};

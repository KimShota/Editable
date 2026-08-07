/** The editor's volume sliders work in dB (CapCut's own -60..+20 range)
 *  even though the EDL stores a plain linear gain (1 = unity, matching
 *  EdlVideoSegmentSchema.volume's doc comment) — dB is the unit people
 *  actually reason about when boosting a quiet take or pulling down a hot
 *  one. MIN_DB doubles as "silent": dragged there, linear volume is exactly
 *  0, not just very quiet, so there's a real floor instead of an asymptote. */
export const MIN_DB = -60;
export const MAX_DB = 20;

export const linearToDb = (volume: number): number =>
  volume <= 0 ? MIN_DB : Math.max(MIN_DB, Math.min(MAX_DB, 20 * Math.log10(volume)));

export const dbToLinear = (db: number): number => (db <= MIN_DB ? 0 : Math.pow(10, db / 20));

export const formatDb = (db: number): string => (db <= MIN_DB ? "-∞" : `${db > 0 ? "+" : ""}${db.toFixed(1)}`);

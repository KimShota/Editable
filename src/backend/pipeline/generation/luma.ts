/**
 * Shared histogram-percentile math over a single-channel (grayscale) byte
 * buffer — the same measurement gates.ts's frameLumaStats and
 * authoring/buildTemplateAssets.ts's imageLumaStats each do on their own
 * ffmpeg-sourced buffer, factored out for relight.ts's subject-only
 * measurement (which needs the same stats but computed only over the
 * pixels a person mask marks as "person", not a whole frame/image).
 */
export type LumaStats = { mean: number; p5: number; p50: number; p90: number; p95: number };

export const lumaStatsFromGrayBuffer = (buf: ArrayLike<number>): LumaStats => {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < buf.length; i++) hist[buf[i]]++;
  const n = buf.length;
  const pct = (p: number) => {
    const target = (n * p) / 100;
    let c = 0;
    for (let v = 0; v < 256; v++) {
      c += hist[v];
      if (c >= target) return v;
    }
    return 255;
  };
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  return { mean: n > 0 ? sum / n : 0, p5: pct(5), p50: pct(50), p90: pct(90), p95: pct(95) };
};

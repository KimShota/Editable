"use client";

import { useEffect, useRef, useState } from "react";
import { computePeaks, getDecodedAudio } from "./waveform";

const MIN_BARS = 6;
const MAX_BARS = 400;
const PX_PER_BAR = 3;

/**
 * A clip's own audio, drawn as bars inside its timeline box. `widthPx` sets
 * bar density (not layout — the canvas itself fills `className`'s box) so a
 * trimmed-down clip doesn't render bars finer than the eye can resolve.
 */
export function ClipWaveform({
  src,
  srcInSec,
  srcOutSec,
  widthPx,
  className,
}: {
  src: string;
  srcInSec: number;
  srcOutSec: number;
  widthPx: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);

  const bars = Math.min(MAX_BARS, Math.max(MIN_BARS, Math.round(widthPx / PX_PER_BAR)));

  useEffect(() => {
    let cancelled = false;
    getDecodedAudio(src)
      .then((audio) => {
        if (cancelled || !audio) return;
        const { channelData, sampleRate } = audio;
        const startSample = Math.max(0, Math.floor(srcInSec * sampleRate));
        const endSample = Math.min(channelData.length, Math.ceil(srcOutSec * sampleRate));
        if (endSample <= startSample) return;
        setPeaks(computePeaks(channelData.subarray(startSample, endSample), bars));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [src, srcInSec, srcOutSec, bars]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    const step = w / peaks.length;
    const barWidth = Math.max(1, step - 1);
    for (let i = 0; i < peaks.length; i++) {
      const amp = Math.max(peaks[i], 0.06);
      const barHeight = amp * h;
      ctx.fillRect(i * step, (h - barHeight) / 2, barWidth, barHeight);
    }
  }, [peaks]);

  if (!peaks) return null;

  return (
    <div className={className}>
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}

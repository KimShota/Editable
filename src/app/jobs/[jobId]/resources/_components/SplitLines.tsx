"use client";

import { useEffect, useRef, useState } from "react";
import type { Format } from "@backend/pipeline/types";
import type { ScriptSuggestion } from "@backend/content/types";
import { Card, Pill } from "../../../../_components/ui";

type TakeSplitBlock = {
  blockId: string;
  srcInSec: number;
  srcOutSec: number;
  confidence: number;
  quote?: string;
};
type SplitState = { durationSec: number; blocks: TakeSplitBlock[] };

const fetchSplit = async (jobId: string): Promise<SplitState | null> => {
  const res = await fetch(`/api/jobs/${jobId}/split`);
  const data = await res.json();
  return data.split ?? null;
};

const runAutoSplit = async (jobId: string): Promise<SplitState> => {
  const res = await fetch(`/api/jobs/${jobId}/split`, { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "split failed");
  return data.split;
};

const saveSpan = async (
  jobId: string,
  blockId: string,
  srcInSec: number,
  srcOutSec: number,
): Promise<SplitState> => {
  const res = await fetch(`/api/jobs/${jobId}/split`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blockId, srcInSec, srcOutSec }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "save failed");
  return data.split;
};

const MIN_SPAN_SEC = 0.2;
const GAP_SEC = 0.05;
const WAVE_BINS = 240;

const mediaUrl = (jobId: string, file: string) => `/api/media/jobs/${jobId}/${file}`;

/** Downsamples a decoded audio track into per-bin peak amplitudes (0..1,
 *  normalized to the loudest bin) for a lightweight waveform render — one
 *  bar per bin rather than one per sample. */
const computePeaks = (buffer: AudioBuffer, bins: number): Float32Array => {
  const channelData = buffer.getChannelData(0);
  const samplesPerBin = Math.max(1, Math.floor(channelData.length / bins));
  const peaks = new Float32Array(bins);
  let max = 0;
  for (let i = 0; i < bins; i++) {
    const start = i * samplesPerBin;
    const end = i === bins - 1 ? channelData.length : start + samplesPerBin;
    let peak = 0;
    for (let j = start; j < end; j++) {
      const abs = Math.abs(channelData[j]);
      if (abs > peak) peak = abs;
    }
    peaks[i] = peak;
    if (peak > max) max = peak;
  }
  if (max > 0) {
    for (let i = 0; i < bins; i++) peaks[i] /= max;
  }
  return peaks;
};

/**
 * "Split your take into lines" — Step 3 of the resources wizard, only
 * rendered when format.speakingTakeSlot is set. Each voice block gets a
 * row: a horizontal strip showing every block's current span (this row's
 * own highlighted in accent, the rest dimmed for context) with two
 * draggable handles on the active span's start/end. Dragging follows the
 * same pointer-capture + delta pattern as the editor's own ResizeHandle —
 * on release, the new span is persisted via PATCH /split, which
 * re-derives that block's transcript/trim slice from the already-stored
 * whole-take words without re-running whisper.
 */
export function SplitLines({
  jobId,
  format,
  script,
  takeFile,
}: {
  jobId: string;
  format: Format;
  script: ScriptSuggestion | null;
  /** Job-relative path to the bound speaking take (e.g.
   *  "assets/speaking-take.mp4"), or undefined if it isn't bound yet — the
   *  split can't run until it is. */
  takeFile?: string;
}) {
  const takeBound = !!takeFile;
  const [split, setSplit] = useState<SplitState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playingBlockId, setPlayingBlockId] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const dragRef = useRef<{ blockId: string; edge: "start" | "end"; lastX: number; pxToSec: number } | null>(
    null,
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopAtRef = useRef<number | null>(null);

  const voiceBlocks = format.blocks.filter((b) => b.kind === "voice");

  useEffect(() => {
    if (!takeBound) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const existing = await fetchSplit(jobId);
        const result = existing ?? (await runAutoSplit(jobId));
        if (!cancelled) setSplit(result);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, takeBound]);

  useEffect(() => {
    if (!takeFile) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(mediaUrl(jobId, takeFile));
        const arrayBuffer = await res.arrayBuffer();
        const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioCtx();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        if (!cancelled) setPeaks(computePeaks(audioBuffer, WAVE_BINS));
        ctx.close();
      } catch {
        // Waveform is a nicety over the flat span bars — fail silently.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, takeFile]);

  const reAlign = async () => {
    setLoading(true);
    setError(null);
    try {
      setSplit(await runAutoSplit(jobId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const lineFor = (blockId: string): string | undefined =>
    script?.suggestions.find((s) => s.blockId === blockId)?.text;

  /** Plays just this block's own span of the shared take, auto-pausing at
   *  its end — the "Play one to check it" the copy above already promised. */
  const playSpan = (span: TakeSplitBlock) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = span.srcInSec;
    stopAtRef.current = span.srcOutSec;
    setPlayingBlockId(span.blockId);
    video.play();
  };

  const onVideoTimeUpdate = () => {
    const video = videoRef.current;
    if (!video || stopAtRef.current === null) return;
    if (video.currentTime >= stopAtRef.current) {
      video.pause();
      stopAtRef.current = null;
      setPlayingBlockId(null);
    }
  };

  const beginDrag = (blockId: string, edge: "start" | "end") => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!split) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const stripWidthPx = e.currentTarget.parentElement?.getBoundingClientRect().width ?? 1;
    dragRef.current = { blockId, edge, lastX: e.clientX, pxToSec: split.durationSec / stripWidthPx };
  };

  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaSec = (e.clientX - drag.lastX) * drag.pxToSec;
    drag.lastX = e.clientX;

    setSplit((prev) => {
      if (!prev) return prev;
      const idx = prev.blocks.findIndex((b) => b.blockId === drag.blockId);
      if (idx === -1) return prev;
      const blocks = [...prev.blocks];
      const block = { ...blocks[idx] };
      const prevBlock = blocks[idx - 1];
      const nextBlock = blocks[idx + 1];
      const minStart = prevBlock ? prevBlock.srcOutSec + GAP_SEC : 0;
      const maxEnd = nextBlock ? nextBlock.srcInSec - GAP_SEC : prev.durationSec;

      if (drag.edge === "start") {
        block.srcInSec = Math.min(Math.max(block.srcInSec + deltaSec, minStart), block.srcOutSec - MIN_SPAN_SEC);
      } else {
        block.srcOutSec = Math.max(Math.min(block.srcOutSec + deltaSec, maxEnd), block.srcInSec + MIN_SPAN_SEC);
      }
      blocks[idx] = block;
      return { ...prev, blocks };
    });
  };

  const onHandlePointerUp = async () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !split) return;
    const block = split.blocks.find((b) => b.blockId === drag.blockId);
    if (!block) return;
    try {
      setSplit(await saveSpan(jobId, block.blockId, block.srcInSec, block.srcOutSec));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!takeBound) {
    return (
      <Card className="p-6">
        <p className="text-sm text-[color:var(--ink-dim)]">
          Upload your speaking take in the previous step first — this step splits it into lines.
        </p>
      </Card>
    );
  }

  if (loading || !split) {
    return (
      <Card className="p-6">
        <p className="text-sm text-[color:var(--ink-dim)]">
          {error ?? "Splitting your take into lines…"}
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--ink)]">
          Split your take into lines
        </h2>
        <button onClick={reAlign} className="text-sm font-medium text-[color:var(--accent)]">
          ↺ Re-align lines
        </button>
      </div>
      <p className="mb-6 text-sm text-[color:var(--ink-dim)]">
        Each line you spoke is now its own clip. Play one to check it, then drag its handles to fix
        where it starts and ends.
      </p>
      {error && <p className="mb-4 text-xs text-red-400">{error}</p>}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]">
        <div className="lg:sticky lg:top-24 lg:self-start">
          {takeFile && (
            <video
              ref={videoRef}
              src={mediaUrl(jobId, takeFile)}
              onTimeUpdate={onVideoTimeUpdate}
              onPause={() => setPlayingBlockId(null)}
              controls
              className="w-full rounded-lg border border-white/10 bg-black"
            />
          )}
        </div>
        <div className="flex flex-col gap-6">
        {voiceBlocks.map((block, i) => {
          const span = split.blocks.find((b) => b.blockId === block.id);
          if (!span) return null;
          const duration = span.srcOutSec - span.srcInSec;
          return (
            <div key={block.id}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => playSpan(span)}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[color:var(--accent)] text-xs font-bold text-[color:var(--accent-ink)] hover:scale-110"
                  aria-label={`Play line ${i + 1}`}
                >
                  {playingBlockId === block.id ? "❚❚" : "▶"}
                </button>
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/15 text-xs font-bold text-[color:var(--ink-dim)]">
                  {i + 1}
                </span>
                <p className="text-sm text-[color:var(--ink)]">{lineFor(block.id) ?? block.title}</p>
                {span.confidence === 0 && <Pill>needs a look</Pill>}
                <span className="ml-auto text-xs text-[color:var(--ink-dim)]">
                  {span.srcInSec.toFixed(1)}s – {span.srcOutSec.toFixed(1)}s · {duration.toFixed(1)}s
                </span>
              </div>
              <div className="relative h-10 w-full overflow-hidden rounded-lg bg-black/30">
                {peaks ? (
                  <div className="absolute inset-0 flex items-center gap-px px-1">
                    {Array.from(peaks).map((amp, idx) => {
                      const t = ((idx + 0.5) / peaks.length) * split.durationSec;
                      const owner = split.blocks.find((b) => t >= b.srcInSec && t <= b.srcOutSec);
                      const active = owner?.blockId === block.id;
                      return (
                        <div
                          key={idx}
                          className={`w-full flex-1 rounded-sm ${
                            active ? "bg-[color:var(--accent)]" : owner ? "bg-white/25" : "bg-white/10"
                          }`}
                          style={{ height: `${Math.max(amp * 100, 6)}%` }}
                        />
                      );
                    })}
                  </div>
                ) : (
                  split.blocks.map((b) => {
                    const left = (b.srcInSec / split.durationSec) * 100;
                    const width = ((b.srcOutSec - b.srcInSec) / split.durationSec) * 100;
                    const active = b.blockId === block.id;
                    return (
                      <div
                        key={b.blockId}
                        className={`absolute top-0 h-full rounded-md ${
                          active ? "bg-[color:var(--accent)]/70" : "bg-white/10"
                        }`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                      />
                    );
                  })
                )}
                <div
                  onPointerDown={beginDrag(block.id, "start")}
                  onPointerMove={onHandlePointerMove}
                  onPointerUp={onHandlePointerUp}
                  className="group absolute top-0 flex h-full w-4 -translate-x-1/2 cursor-ew-resize flex-col items-center py-0.5"
                  style={{ left: `${(span.srcInSec / split.durationSec) * 100}%` }}
                >
                  <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-[color:var(--accent)] transition-transform group-hover:scale-125 group-active:scale-125" />
                  <div className="w-0.5 flex-1 bg-[color:var(--accent)]" />
                  <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-[color:var(--accent)] transition-transform group-hover:scale-125 group-active:scale-125" />
                </div>
                <div
                  onPointerDown={beginDrag(block.id, "end")}
                  onPointerMove={onHandlePointerMove}
                  onPointerUp={onHandlePointerUp}
                  className="group absolute top-0 flex h-full w-4 -translate-x-1/2 cursor-ew-resize flex-col items-center py-0.5"
                  style={{ left: `${(span.srcOutSec / split.durationSec) * 100}%` }}
                >
                  <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-[color:var(--accent)] transition-transform group-hover:scale-125 group-active:scale-125" />
                  <div className="w-0.5 flex-1 bg-[color:var(--accent)]" />
                  <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-[color:var(--accent)] transition-transform group-hover:scale-125 group-active:scale-125" />
                </div>
              </div>
            </div>
          );
        })}
        </div>
      </div>
    </Card>
  );
}

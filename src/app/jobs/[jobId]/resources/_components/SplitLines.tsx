"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Format } from "@backend/pipeline/types";
import type { ScriptSuggestion } from "@backend/content/types";
import { Card, Pill } from "../../../../_components/ui";

type TakeSplitBlock = {
  blockId: string;
  srcInSec: number;
  srcOutSec: number;
  confidence: number;
  quote?: string;
  /** Which original uploaded clip this segment was found in — undefined
   *  for an ordinary single-clip take, where every block has exactly one
   *  segment and there's nothing to disambiguate. See splitTake.ts's own
   *  TakeSplit.clipPath doc comment. */
  clipPath?: string;
};
type SplitState = { durationSec: number; blocks: TakeSplitBlock[] };

/** Converts between COMBINED-file time (what every span's srcInSec/
 *  srcOutSec is always in, regardless of clip count) and one original
 *  clip's own NATIVE playback time — see the split route's own
 *  buildClipWindows doc comment. A single-clip take's window is the
 *  identity mapping, so every panel below can use this same conversion
 *  whether the take turned out to be one clip or several. */
type ClipWindow = { path: string; offsetSec: number; srcInSec: number };

type SplitFetchResult = { split: SplitState | null; takeFile?: string; clipWindows: ClipWindow[] };

const fetchSplit = async (jobId: string): Promise<SplitFetchResult> => {
  const res = await fetch(`/api/jobs/${jobId}/split`);
  const data = await res.json();
  return { split: data.split ?? null, takeFile: data.takeFile, clipWindows: data.clipWindows ?? [] };
};

const runAutoSplit = async (jobId: string): Promise<SplitFetchResult> => {
  const res = await fetch(`/api/jobs/${jobId}/split`, { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "split failed");
  return { split: data.split, takeFile: data.takeFile, clipWindows: data.clipWindows ?? [] };
};

const saveSpan = async (
  jobId: string,
  blockId: string,
  clipPath: string | undefined,
  srcInSec: number,
  srcOutSec: number,
): Promise<SplitState> => {
  const res = await fetch(`/api/jobs/${jobId}/split`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blockId, clipPath, srcInSec, srcOutSec }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "save failed");
  return data.split;
};

const MIN_SPAN_SEC = 0.2;
const GAP_SEC = 0.05;
const WAVE_BINS = 240;
/** A span this far below full confidence gets the "needs a look" flag —
 *  covers both the ordinary single-walk fallback (confidence exactly 0)
 *  and the multi-clip utterance fallback (a fixed low, nonzero value —
 *  see splitTake.ts's UTTERANCE_FALLBACK_CONFIDENCE). */
const NEEDS_LOOK_THRESHOLD = 0.5;
/** Combined-time breathing room added around a panel's own segments when
 *  picking how much of the timeline that panel's strip/waveform shows. */
const PANEL_MARGIN_SEC = 0.5;

const mediaUrl = (jobId: string, file: string) => `/api/media/jobs/${jobId}/${file}`;

const toClipTimeSec = (combinedSec: number, win: ClipWindow): number => combinedSec - win.offsetSec + win.srcInSec;

/** Downsamples a slice of decoded audio into per-bin peak amplitudes
 *  (0..1, normalized to the loudest bin) for a lightweight waveform render
 *  — one bar per bin rather than one per sample. Takes the raw channel
 *  data directly (not a whole AudioBuffer) so a caller can pass just the
 *  sample range it wants zoomed in on. */
const computePeaks = (channelData: Float32Array, bins: number): Float32Array => {
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

type PanelSegment = {
  block: { id: string; title: string };
  globalIndex: number;
  span: TakeSplitBlock;
};

/**
 * One clip's own check — "Split your take into lines", scoped to a SINGLE
 * uploaded clip, showing only the lines that clip actually contributed
 * footage to (see splitTake.ts's splitMultiClipTake: a multi-clip take can
 * split every line's content across several clips, so "the split UI" is no
 * longer one shared timeline but one panel per clip). An ordinary single-
 * clip take renders exactly one of these, covering every line — visually
 * equivalent to what this whole component used to be before multi-clip
 * support existed.
 */
function ClipPanel({
  jobId,
  clipPath,
  clipWindow: win,
  segments,
  onAdjust,
}: {
  jobId: string;
  clipPath: string;
  clipWindow: ClipWindow;
  segments: PanelSegment[];
  onAdjust: (blockId: string, srcInSec: number, srcOutSec: number) => Promise<void>;
}) {
  const [playingBlockId, setPlayingBlockId] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopAtRef = useRef<number | null>(null);
  const dragRef = useRef<{ blockId: string; edge: "start" | "end"; lastX: number; pxToSec: number } | null>(null);

  const panelMinSec = Math.max(0, Math.min(...segments.map((s) => s.span.srcInSec)) - PANEL_MARGIN_SEC);
  const panelMaxSec = Math.max(...segments.map((s) => s.span.srcOutSec)) + PANEL_MARGIN_SEC;
  const panelSpanSec = Math.max(0.1, panelMaxSec - panelMinSec);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(mediaUrl(jobId, clipPath));
        const arrayBuffer = await res.arrayBuffer();
        const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioCtx();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        const sampleRate = audioBuffer.sampleRate;
        const startSample = Math.max(0, Math.floor(toClipTimeSec(panelMinSec, win) * sampleRate));
        const endSample = Math.min(audioBuffer.length, Math.ceil(toClipTimeSec(panelMaxSec, win) * sampleRate));
        const channelData = audioBuffer.getChannelData(0).subarray(startSample, endSample);
        if (!cancelled) setPeaks(computePeaks(channelData, WAVE_BINS));
        ctx.close();
      } catch {
        // Waveform is a nicety over the flat span bars — fail silently.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, clipPath]);

  const playSpan = (span: TakeSplitBlock) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = toClipTimeSec(span.srcInSec, win);
    stopAtRef.current = toClipTimeSec(span.srcOutSec, win);
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
    e.currentTarget.setPointerCapture(e.pointerId);
    const stripWidthPx = e.currentTarget.parentElement?.getBoundingClientRect().width ?? 1;
    dragRef.current = { blockId, edge, lastX: e.clientX, pxToSec: panelSpanSec / stripWidthPx };
  };

  // Dragged spans are tracked locally (not lifted into parent state) while
  // in flight, since only THIS panel's own strip needs to redraw live —
  // committed to the shared split state (and the server) on pointer up.
  const [liveSpans, setLiveSpans] = useState<Record<string, TakeSplitBlock>>({});
  const spanFor = (seg: PanelSegment): TakeSplitBlock => liveSpans[seg.span.blockId] ?? seg.span;

  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaSec = (e.clientX - drag.lastX) * drag.pxToSec;
    drag.lastX = e.clientX;

    setLiveSpans((prev) => {
      const idx = segments.findIndex((s) => s.span.blockId === drag.blockId);
      if (idx === -1) return prev;
      const current = prev[drag.blockId] ?? segments[idx].span;
      const prevSeg = segments[idx - 1];
      const nextSeg = segments[idx + 1];
      const minStart = prevSeg ? (prev[prevSeg.span.blockId] ?? prevSeg.span).srcOutSec + GAP_SEC : panelMinSec;
      const maxEnd = nextSeg ? (prev[nextSeg.span.blockId] ?? nextSeg.span).srcInSec - GAP_SEC : panelMaxSec;

      const next = { ...current };
      if (drag.edge === "start") {
        next.srcInSec = Math.min(Math.max(current.srcInSec + deltaSec, minStart), current.srcOutSec - MIN_SPAN_SEC);
      } else {
        next.srcOutSec = Math.max(Math.min(current.srcOutSec + deltaSec, maxEnd), current.srcInSec + MIN_SPAN_SEC);
      }
      return { ...prev, [drag.blockId]: next };
    });
  };

  const onHandlePointerUp = async () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const span = liveSpans[drag.blockId];
    if (!span) return;
    await onAdjust(drag.blockId, span.srcInSec, span.srcOutSec);
    setLiveSpans((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== drag.blockId)));
  };

  return (
    <div className="grid grid-cols-1 gap-6 border-t border-white/10 pt-6 first:border-t-0 first:pt-0 lg:grid-cols-[220px_1fr]">
      <div className="lg:sticky lg:top-24 lg:self-start">
        <video
          ref={videoRef}
          src={mediaUrl(jobId, clipPath)}
          onTimeUpdate={onVideoTimeUpdate}
          onPause={() => setPlayingBlockId(null)}
          controls
          className="w-full rounded-lg border border-white/10 bg-black"
        />
        <p className="mt-2 truncate text-xs text-[color:var(--ink-dim)]" title={clipPath}>
          {clipPath.split("/").pop()}
        </p>
      </div>
      <div className="flex flex-col gap-6">
        {segments.map((seg) => {
          const span = spanFor(seg);
          const duration = span.srcOutSec - span.srcInSec;
          return (
            <div key={seg.block.id}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => playSpan(span)}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[color:var(--accent)] text-xs font-bold text-[color:var(--accent-ink)] hover:scale-110"
                  aria-label={`Play line ${seg.globalIndex + 1}`}
                >
                  {playingBlockId === seg.block.id ? "❚❚" : "▶"}
                </button>
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/15 text-xs font-bold text-[color:var(--ink-dim)]">
                  {seg.globalIndex + 1}
                </span>
                <p className="text-sm text-[color:var(--ink)]">{seg.block.title}</p>
                {span.confidence < NEEDS_LOOK_THRESHOLD && <Pill>needs a look</Pill>}
                <span className="ml-auto text-xs text-[color:var(--ink-dim)]">
                  {span.srcInSec.toFixed(1)}s – {span.srcOutSec.toFixed(1)}s · {duration.toFixed(1)}s
                </span>
              </div>
              <div className="relative h-10 w-full overflow-hidden rounded-lg bg-black/30">
                {peaks ? (
                  <div className="absolute inset-0 flex items-center gap-px px-1">
                    {Array.from(peaks).map((amp, idx) => {
                      const t = panelMinSec + ((idx + 0.5) / peaks.length) * panelSpanSec;
                      const owner = segments.find((s) => {
                        const os = spanFor(s);
                        return t >= os.srcInSec && t <= os.srcOutSec;
                      });
                      const active = owner?.block.id === seg.block.id;
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
                  segments.map((s) => {
                    const os = spanFor(s);
                    const left = ((os.srcInSec - panelMinSec) / panelSpanSec) * 100;
                    const width = ((os.srcOutSec - os.srcInSec) / panelSpanSec) * 100;
                    const active = s.block.id === seg.block.id;
                    return (
                      <div
                        key={s.block.id}
                        className={`absolute top-0 h-full rounded-md ${
                          active ? "bg-[color:var(--accent)]/70" : "bg-white/10"
                        }`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                      />
                    );
                  })
                )}
                <div
                  onPointerDown={beginDrag(seg.block.id, "start")}
                  onPointerMove={onHandlePointerMove}
                  onPointerUp={onHandlePointerUp}
                  className="group absolute top-0 flex h-full w-4 -translate-x-1/2 cursor-ew-resize flex-col items-center py-0.5"
                  style={{ left: `${((span.srcInSec - panelMinSec) / panelSpanSec) * 100}%` }}
                >
                  <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-[color:var(--accent)] transition-transform group-hover:scale-125 group-active:scale-125" />
                  <div className="w-0.5 flex-1 bg-[color:var(--accent)]" />
                  <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-[color:var(--accent)] transition-transform group-hover:scale-125 group-active:scale-125" />
                </div>
                <div
                  onPointerDown={beginDrag(seg.block.id, "end")}
                  onPointerMove={onHandlePointerMove}
                  onPointerUp={onHandlePointerUp}
                  className="group absolute top-0 flex h-full w-4 -translate-x-1/2 cursor-ew-resize flex-col items-center py-0.5"
                  style={{ left: `${((span.srcOutSec - panelMinSec) / panelSpanSec) * 100}%` }}
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
  );
}

/**
 * "Split your take into lines" — Step 3 of the resources wizard, only
 * rendered when format.speakingTakeSlot is set. Renders one ClipPanel per
 * ORIGINAL uploaded clip (a single-clip take renders exactly one, covering
 * every line — see splitTake.ts's own doc comment for why a multi-clip
 * take can't share one panel/timeline: each clip may contain only a
 * FRAGMENT of every line, not a few whole lines each, so checking a line
 * means checking it against each clip that contributed to it separately).
 */
export function SplitLines({
  jobId,
  format,
  script,
  takeFile,
  takeBound,
}: {
  jobId: string;
  format: Format;
  script: ScriptSuggestion | null;
  /** Job-relative path to the bound speaking take (e.g.
   *  "assets/speaking-take.mp4") — a same-render fallback for the FIRST
   *  paint, before the split GET/POST below has resolved the real media
   *  (for a multi-clip take, that's the derived combined file, which this
   *  prop alone can't know — see the split route's own takeFile). */
  takeFile?: string;
  /** Whether the take slot has ANY binding (single clip or several) — the
   *  split can't run until it does. Distinct from `takeFile` because a
   *  fresh multi-clip binding is bound but has no resolved media path yet. */
  takeBound: boolean;
}) {
  const [split, setSplit] = useState<SplitState | null>(null);
  const [clipWindows, setClipWindows] = useState<ClipWindow[]>(takeFile ? [{ path: takeFile, offsetSec: 0, srcInSec: 0 }] : []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
        const result = existing.split ? existing : await runAutoSplit(jobId);
        if (!cancelled) {
          setSplit(result.split);
          setClipWindows(result.clipWindows);
        }
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

  const reAlign = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await runAutoSplit(jobId);
      setSplit(result.split);
      setClipWindows(result.clipWindows);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const lineFor = (blockId: string): string | undefined =>
    script?.suggestions.find((s) => s.blockId === blockId)?.text;

  const adjust = async (clipPath: string | undefined, blockId: string, srcInSec: number, srcOutSec: number) => {
    try {
      setSplit(await saveSpan(jobId, blockId, clipPath, srcInSec, srcOutSec));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const panels = useMemo(() => {
    if (!split) return [];
    const blockIndex = new Map(voiceBlocks.map((b, i) => [b.id, i]));
    const fallbackClipPath = clipWindows[0]?.path;
    const byClip = new Map<string, PanelSegment[]>();
    for (const span of split.blocks) {
      const clipPath = span.clipPath ?? fallbackClipPath;
      if (!clipPath) continue;
      const block = voiceBlocks.find((b) => b.id === span.blockId);
      if (!block) continue;
      if (!byClip.has(clipPath)) byClip.set(clipPath, []);
      byClip.get(clipPath)!.push({ block: { id: block.id, title: lineFor(block.id) ?? block.title }, globalIndex: blockIndex.get(block.id) ?? 0, span });
    }
    return clipWindows
      .filter((w) => byClip.has(w.path))
      .map((w) => ({
        window: w,
        segments: byClip.get(w.path)!.sort((a, b) => a.globalIndex - b.globalIndex),
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [split, clipWindows]);

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
        {panels.length > 1
          ? "You filmed this in more than one clip — each clip gets its own check below, showing only the lines it covers. Play a line to check it, then drag its handles to fix where it starts and ends."
          : "Each line you spoke is now its own clip. Play one to check it, then drag its handles to fix where it starts and ends."}
      </p>
      {error && <p className="mb-4 text-xs text-red-400">{error}</p>}
      <div className="flex flex-col gap-8">
        {panels.map(({ window: w, segments }) => (
          <ClipPanel
            key={w.path}
            jobId={jobId}
            clipPath={w.path}
            clipWindow={w}
            segments={segments}
            onAdjust={(blockId, srcInSec, srcOutSec) => adjust(w.path, blockId, srcInSec, srcOutSec)}
          />
        ))}
      </div>
    </Card>
  );
}

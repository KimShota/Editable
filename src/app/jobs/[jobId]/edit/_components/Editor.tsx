"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Player, PlayerRef } from "@remotion/player";
import { EdlVideo } from "@backend/remotion/EdlVideo";
import type { Edl } from "@backend/pipeline/types";
import type { TimelineOp } from "@backend/pipeline/timelineOps";
import { Timeline } from "./Timeline";
import { Inspector } from "./Inspector";
import { MediaPanel } from "./MediaPanel";
import { RenderPanel } from "./RenderPanel";
import { ResizeHandle } from "./ResizeHandle";
import { Selection } from "./selection";
import { formatTimecode } from "./timeFormat";

const LAYOUT_KEY = "editable-editor-layout";
type Layout = { mediaPanelWidth: number; inspectorWidth: number; timelineHeight: number };
const DEFAULT_LAYOUT: Layout = { mediaPanelWidth: 256, inspectorWidth: 320, timelineHeight: 256 };

const loadLayout = (): Layout => {
  if (typeof window === "undefined") return DEFAULT_LAYOUT;
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    return raw ? { ...DEFAULT_LAYOUT, ...JSON.parse(raw) } : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
};

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * A CapCut/Premiere-style non-linear editor: the left panel reflects the
 * job's own media, the center is the live preview, the right panel edits
 * whatever's selected, and the bottom timeline IS the document — every
 * gesture there is a timeline op sent straight to /timeline/op, which
 * mutates edl.json directly. There's no "regenerate from the template"
 * step in this loop; that only happens via the explicit reset button,
 * which discards these edits (see RenderPanel's neighbor action, TODO).
 */
export function Editor({
  jobId,
  formatName,
  initialEdl,
}: {
  jobId: string;
  formatName: string;
  initialEdl: Edl;
}) {
  const [edl, setEdl] = useState<Edl>(initialEdl);
  const [selection, setSelection] = useState<Selection>(null);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [layout, setLayout] = useState<Layout>(loadLayout);

  const playerRef = useRef<PlayerRef>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // Best-effort only — a full/blocked localStorage just means the
      // panel sizes won't persist across reloads.
    }
  }, [layout]);

  const resizeMediaPanel = (dx: number) =>
    setLayout((l) => ({ ...l, mediaPanelWidth: clamp(l.mediaPanelWidth + dx, 180, 480) }));
  const resizeInspector = (dx: number) =>
    setLayout((l) => ({ ...l, inspectorWidth: clamp(l.inspectorWidth - dx, 240, 480) }));
  const resizeTimeline = (dy: number) =>
    setLayout((l) => ({ ...l, timelineHeight: clamp(l.timelineHeight - dy, 140, 560) }));

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onFrame = (e: { detail: { frame: number } }) => setCurrentTimeSec(e.detail.frame / edl.fps);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    player.addEventListener("frameupdate", onFrame);
    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    return () => {
      player.removeEventListener("frameupdate", onFrame);
      player.removeEventListener("play", onPlay);
      player.removeEventListener("pause", onPause);
    };
  }, [edl.fps]);

  const seekToSec = useCallback(
    (sec: number) => {
      playerRef.current?.seekTo(Math.round(Math.max(0, Math.min(sec, edl.durationSec)) * edl.fps));
    },
    [edl.durationSec, edl.fps],
  );

  const submitOp = useCallback(
    async (op: TimelineOp) => {
      setPending(true);
      setError(null);
      try {
        const res = await fetch(`/api/jobs/${jobId}/timeline/op`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(op),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "edit failed");
        setEdl(data.edl as Edl);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setPending(false);
      }
    },
    [jobId],
  );

  // Delete/Backspace deletes the selected clip; Space toggles play/pause.
  // Both are ignored while typing in a text field (the overlay text editor).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

      if ((e.key === "Delete" || e.key === "Backspace") && selection) {
        if (selection.track === "video" || selection.track === "overlay" || selection.track === "sfx") {
          e.preventDefault();
          submitOp({ type: "delete", track: selection.track, id: selection.id });
        }
      }
      if (e.key === " ") {
        e.preventDefault();
        playerRef.current?.toggle();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selection, submitOp]);

  const jumpTo = (sel: Selection, tlInSec: number) => {
    setSelection(sel);
    seekToSec(tlInSec);
  };

  return (
    <div className="flex h-full w-full flex-col bg-[color:var(--bg)] text-[color:var(--ink)]">
      {/* Top bar */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/8 px-4">
        <div className="flex items-center gap-3">
          <Link href="/library" className="text-[color:var(--ink-dim)] hover:text-[color:var(--ink)]">
            ←
          </Link>
          <div>
            <p className="font-[family-name:var(--font-display)] text-sm font-bold text-[color:var(--ink)]">
              {formatName}
            </p>
            <p className="text-[11px] text-[color:var(--ink-dim)]">{jobId}</p>
          </div>
          {pending && <span className="text-[11px] text-[color:var(--ink-dim)]">Saving…</span>}
        </div>
        <div className="relative">
          <button
            onClick={() => setExportOpen((v) => !v)}
            className="rounded-full bg-[color:var(--accent)] px-5 py-2 font-[family-name:var(--font-display)] text-sm font-bold text-[color:var(--accent-ink)] hover:scale-[1.03]"
          >
            Export
          </button>
          {exportOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
              <div className="absolute top-12 right-0 z-50 w-96">
                <RenderPanel jobId={jobId} />
              </div>
            </>
          )}
        </div>
      </div>

      {error && (
        <p className="border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-sm text-red-400">{error}</p>
      )}

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        <div style={{ width: layout.mediaPanelWidth }} className="shrink-0">
          <MediaPanel edl={edl} onJumpTo={jumpTo} />
        </div>
        <ResizeHandle orientation="vertical" onResize={resizeMediaPanel} />

        <div className="flex min-w-0 flex-1 flex-col bg-black/20">
          <div className="flex flex-1 items-center justify-center overflow-hidden p-6">
            <div className="h-full max-h-full" style={{ aspectRatio: `${edl.width} / ${edl.height}` }}>
              <Player
                ref={playerRef}
                component={EdlVideo}
                inputProps={{ edl }}
                durationInFrames={Math.max(1, Math.round(edl.durationSec * edl.fps))}
                fps={edl.fps}
                compositionWidth={edl.width}
                compositionHeight={edl.height}
                style={{ width: "100%", height: "100%" }}
                loop
              />
            </div>
          </div>
          <div className="flex shrink-0 items-center justify-center gap-4 border-t border-white/8 py-2">
            <button
              onClick={() => playerRef.current?.toggle()}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-[color:var(--ink)] hover:bg-white/20"
            >
              {isPlaying ? "⏸" : "▶"}
            </button>
            <p className="font-mono text-xs text-[color:var(--ink-dim)]">
              {formatTimecode(currentTimeSec)} / {formatTimecode(edl.durationSec)}
            </p>
          </div>
        </div>

        <ResizeHandle orientation="vertical" onResize={resizeInspector} />
        <div style={{ width: layout.inspectorWidth }} className="shrink-0">
          <Inspector
            edl={edl}
            selection={selection}
            currentTimeSec={currentTimeSec}
            onOp={submitOp}
            onDeselect={() => setSelection(null)}
          />
        </div>
      </div>

      <ResizeHandle orientation="horizontal" onResize={resizeTimeline} />

      {/* Timeline */}
      <div style={{ height: layout.timelineHeight }} className="shrink-0">
        <Timeline
          edl={edl}
          selection={selection}
          onSelect={setSelection}
          currentTimeSec={currentTimeSec}
          onSeek={seekToSec}
          onOp={submitOp}
        />
      </div>
    </div>
  );
}

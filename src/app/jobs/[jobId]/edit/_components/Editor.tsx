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
import {
  ArrowLeftIcon,
  CheckIcon,
  FrameBackIcon,
  FrameForwardIcon,
  PauseIcon,
  PlayIcon,
  RedoIcon,
  SkipEndIcon,
  SkipStartIcon,
  UndoIcon,
} from "./Icons";

const LAYOUT_KEY = "editable-editor-layout";
type Layout = { mediaPanelWidth: number; inspectorWidth: number; timelineHeight: number };
const DEFAULT_LAYOUT: Layout = { mediaPanelWidth: 260, inspectorWidth: 320, timelineHeight: 260 };
/** How many steps back undo can go — each entry is one small EDL
 *  snapshot (a few KB of JSON), so this is generous without being
 *  memory-relevant for a single editing session. */
const MAX_HISTORY = 50;

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

const panelClass = "rounded-xl border border-[color:var(--ed-border)] bg-[color:var(--ed-panel)] overflow-hidden";

const TransportButton = ({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) => (
  <button
    onClick={onClick}
    title={title}
    className="flex h-7 w-7 items-center justify-center rounded-lg text-[color:var(--ed-ink-dim)] transition-colors hover:bg-[color:var(--ed-raised)] hover:text-[color:var(--ed-ink)]"
  >
    {children}
  </button>
);

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
  const [undoStack, setUndoStack] = useState<Edl[]>([]);
  const [redoStack, setRedoStack] = useState<Edl[]>([]);

  const playerRef = useRef<PlayerRef>(null);
  const totalFrames = Math.max(1, Math.round(edl.durationSec * edl.fps));

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

  const stepFrame = useCallback(
    (delta: number) => {
      const player = playerRef.current;
      if (!player) return;
      player.seekTo(clamp(player.getCurrentFrame() + delta, 0, totalFrames - 1));
    },
    [totalFrames],
  );

  // Every op — including undo/redo's own "restore" — goes through this;
  // it never touches the undo/redo stacks itself, so restoring a snapshot
  // can't pollute its own history.
  const sendOpToServer = useCallback(
    async (op: TimelineOp): Promise<Edl | null> => {
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
        return data.edl as Edl;
      } catch (err) {
        setError((err as Error).message);
        return null;
      } finally {
        setPending(false);
      }
    },
    [jobId],
  );

  // Regular edits: push the pre-op document onto undo history and clear
  // redo (a fresh edit invalidates whatever "future" existed).
  const submitOp = useCallback(
    async (op: TimelineOp) => {
      const previous = edl;
      const next = await sendOpToServer(op);
      if (!next) return;
      setUndoStack((s) => [...s.slice(-(MAX_HISTORY - 1)), previous]);
      setRedoStack([]);
      setEdl(next);
    },
    [edl, sendOpToServer],
  );

  const undo = useCallback(async () => {
    if (undoStack.length === 0 || pending) return;
    const target = undoStack[undoStack.length - 1];
    const restored = await sendOpToServer({ type: "restore", edl: target });
    if (!restored) return;
    setUndoStack((s) => s.slice(0, -1));
    setRedoStack((s) => [...s.slice(-(MAX_HISTORY - 1)), edl]);
    setEdl(restored);
    setSelection(null);
  }, [undoStack, edl, pending, sendOpToServer]);

  const redo = useCallback(async () => {
    if (redoStack.length === 0 || pending) return;
    const target = redoStack[redoStack.length - 1];
    const restored = await sendOpToServer({ type: "restore", edl: target });
    if (!restored) return;
    setRedoStack((s) => s.slice(0, -1));
    setUndoStack((s) => [...s.slice(-(MAX_HISTORY - 1)), edl]);
    setEdl(restored);
    setSelection(null);
  }, [redoStack, edl, pending, sendOpToServer]);

  // Delete/Backspace deletes the selected clip; Space toggles play/pause;
  // arrow keys step one frame; Cmd/Ctrl+Z undoes, Shift adds redo (Ctrl+Y
  // also redoes, the Windows convention). All ignored while typing in a
  // text field (the overlay text editor).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === "y") {
        e.preventDefault();
        redo();
        return;
      }

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
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepFrame(-1);
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        stepFrame(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selection, submitOp, stepFrame, undo, redo]);

  const jumpTo = (sel: Selection, tlInSec: number) => {
    setSelection(sel);
    seekToSec(tlInSec);
  };

  return (
    <div className="editor-theme flex h-full w-full flex-col">
      {/* Top bar */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-[color:var(--ed-border)] px-4">
        <div className="flex items-center gap-3">
          <Link
            href="/library"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[color:var(--ed-ink-dim)] transition-colors hover:bg-[color:var(--ed-raised)] hover:text-[color:var(--ed-ink)]"
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </Link>
          <div className="h-5 w-px bg-[color:var(--ed-border-strong)]" />
          <div>
            <p className="font-[family-name:var(--ed-font-display)] text-sm font-semibold text-[color:var(--ed-ink)]">
              {formatName}
            </p>
            <p className="font-mono text-[10px] tracking-wide text-[color:var(--ed-ink-faint)]">{jobId}</p>
          </div>
          <div className="h-5 w-px bg-[color:var(--ed-border-strong)]" />
          <div className="flex items-center gap-1">
            <button
              onClick={undo}
              disabled={undoStack.length === 0 || pending}
              title="Undo (⌘Z)"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-[color:var(--ed-ink-dim)] transition-colors hover:bg-[color:var(--ed-raised)] hover:text-[color:var(--ed-ink)] disabled:pointer-events-none disabled:opacity-30"
            >
              <UndoIcon className="h-4 w-4" />
            </button>
            <button
              onClick={redo}
              disabled={redoStack.length === 0 || pending}
              title="Redo (⌘⇧Z)"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-[color:var(--ed-ink-dim)] transition-colors hover:bg-[color:var(--ed-raised)] hover:text-[color:var(--ed-ink)] disabled:pointer-events-none disabled:opacity-30"
            >
              <RedoIcon className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 rounded-full border border-[color:var(--ed-border)] px-2.5 py-1 text-[11px] text-[color:var(--ed-ink-dim)]">
            {pending ? (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--ed-accent)]" />
            ) : (
              <CheckIcon className="h-3 w-3" />
            )}
            {pending ? "Saving…" : "Saved"}
          </span>

          <div className="relative">
            <button
              onClick={() => setExportOpen((v) => !v)}
              className="rounded-lg bg-[color:var(--ed-accent)] px-4 py-2 font-[family-name:var(--ed-font-display)] text-sm font-semibold text-[color:var(--ed-accent-ink)] transition-transform hover:scale-[1.02] active:scale-[0.98]"
            >
              Export
            </button>
            {exportOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
                <div className="absolute top-11 right-0 z-50 w-96">
                  <RenderPanel jobId={jobId} />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {error && (
        <p className="border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-sm text-[color:var(--ed-danger)]">
          {error}
        </p>
      )}

      {/* Canvas — the inset floating-panel workspace */}
      <div className="flex min-h-0 flex-1 flex-col p-2.5">
        <div className="flex min-h-0 flex-1">
          <div style={{ width: layout.mediaPanelWidth }} className={`shrink-0 ${panelClass}`}>
            <MediaPanel edl={edl} onJumpTo={jumpTo} />
          </div>
          <ResizeHandle orientation="vertical" onResize={resizeMediaPanel} />

          <div className={`flex min-w-0 flex-1 flex-col ${panelClass}`}>
            <div className="flex flex-1 items-center justify-center overflow-hidden bg-black p-6">
              <div className="h-full max-h-full" style={{ aspectRatio: `${edl.width} / ${edl.height}` }}>
                <Player
                  ref={playerRef}
                  component={EdlVideo}
                  inputProps={{ edl }}
                  durationInFrames={totalFrames}
                  fps={edl.fps}
                  compositionWidth={edl.width}
                  compositionHeight={edl.height}
                  style={{ width: "100%", height: "100%" }}
                  loop
                />
              </div>
            </div>
            <div className="flex shrink-0 items-center justify-center gap-1 border-t border-[color:var(--ed-border)] py-2.5">
              <TransportButton onClick={() => playerRef.current?.seekTo(0)} title="Jump to start">
                <SkipStartIcon className="h-4 w-4" />
              </TransportButton>
              <TransportButton onClick={() => stepFrame(-1)} title="Previous frame">
                <FrameBackIcon className="h-4 w-4" />
              </TransportButton>
              <button
                onClick={() => playerRef.current?.toggle()}
                className="mx-1 flex h-9 w-9 items-center justify-center rounded-full bg-[color:var(--ed-accent)] text-[color:var(--ed-accent-ink)] transition-transform hover:scale-105 active:scale-95"
              >
                {isPlaying ? (
                  <PauseIcon className="h-4 w-4" />
                ) : (
                  <PlayIcon className="h-4 w-4 translate-x-[1px]" />
                )}
              </button>
              <TransportButton onClick={() => stepFrame(1)} title="Next frame">
                <FrameForwardIcon className="h-4 w-4" />
              </TransportButton>
              <TransportButton onClick={() => playerRef.current?.seekTo(totalFrames - 1)} title="Jump to end">
                <SkipEndIcon className="h-4 w-4" />
              </TransportButton>
              <p className="ml-3 font-mono text-xs tabular-nums text-[color:var(--ed-ink-dim)]">
                {formatTimecode(currentTimeSec)}{" "}
                <span className="text-[color:var(--ed-ink-faint)]">/</span> {formatTimecode(edl.durationSec)}
              </p>
            </div>
          </div>

          <ResizeHandle orientation="vertical" onResize={resizeInspector} />
          <div style={{ width: layout.inspectorWidth }} className={`shrink-0 ${panelClass}`}>
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

        <div style={{ height: layout.timelineHeight }} className={`shrink-0 ${panelClass}`}>
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
    </div>
  );
}

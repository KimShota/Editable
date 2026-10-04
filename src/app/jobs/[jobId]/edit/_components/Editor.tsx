"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Player, PlayerRef } from "@remotion/player";
import { EdlVideo } from "@backend/remotion/EdlVideo";
import type { Edl } from "@backend/pipeline/types";
import type { TimelineOp } from "@backend/pipeline/timelineOps";
import type { QuotaStatus } from "../../../../lib/quota";
import { Timeline, type UploadPlacement } from "./Timeline";
import { Inspector } from "./Inspector";
import { ClipTakes } from "./ClipTakes";
import { ShotChat } from "./ShotChat";
import { MediaPanel } from "./MediaPanel";
import { OverlayCanvas } from "./OverlayCanvas";
import { RenderPanel } from "./RenderPanel";
import { ResizeHandle } from "./ResizeHandle";
import { MediaKind, Selection } from "./selection";
import { formatTimecode } from "./timeFormat";
import { TEXT_OVERLAY_DRAG_TYPE, buildAddTextOverlayOp } from "./textOverlay";
import {
  ArrowLeftIcon,
  CheckIcon,
  CollapseIcon,
  ExpandIcon,
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

/** While playing, re-rendering the whole editor tree (timeline playhead,
 *  Inspector, OverlayCanvas) on every one of the Player's ~30/sec frame
 *  ticks competes with the Player itself for the main thread it needs to
 *  decode/paint smoothly — that contention is a big part of why preview
 *  playback stutters. Capping the editor's own re-render rate frees that
 *  thread up without losing any real precision: nothing downstream needs
 *  frame-exact chrome updates DURING playback. Scrubbing/stepping (not
 *  playing) still updates on every tick for a responsive feel — see the
 *  frameupdate listener below. */
const PLAYBACK_UI_THROTTLE_MS = 80;

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
/** How often the editor checks on clips that are regenerating. A new take
 *  takes one to several minutes, so a few seconds of lag is invisible. */
const REGEN_POLL_MS = 4000;

type RegenStatus = { status: "running" | "done" | "error"; error?: string };

export function Editor({
  jobId,
  formatName,
  initialEdl,
  aiVideo = false,
  backHref,
  subtitle,
}: {
  jobId: string;
  formatName: string;
  initialEdl: Edl;
  /** Where the arrow in the top bar goes; the old template flow's resources
   *  page when omitted. */
  backHref?: string;
  /** Shown under the title instead of the job id (which means nothing to a
   *  customer reviewing a brand video). */
  subtitle?: string;
  /** Made by the production pipeline: every main-track clip gets a
   *  Regenerate button (a new AI take of that shot). */
  aiVideo?: boolean;
}) {
  const [edl, setEdl] = useState<Edl>(initialEdl);
  const [selection, setSelection] = useState<Selection>(null);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  const [undoStack, setUndoStack] = useState<Edl[]>([]);
  const [redoStack, setRedoStack] = useState<Edl[]>([]);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);

  const playerRef = useRef<PlayerRef>(null);
  const totalFrames = Math.max(1, Math.round(edl.durationSec * edl.fps));
  // Stable object identity across the ~30/sec re-renders driven by
  // currentTimeSec — otherwise the Player treats every frame tick as a
  // composition-props change and invalidates the whole render tree.
  const playerInputProps = useMemo(() => ({ edl, previewMode: true }), [edl]);

  // The exact playhead position, updated on every one of the Player's own
  // ~30/sec frame ticks regardless of throttling below — anything that
  // reads the CURRENT instant (upload-at-playhead, frame stepping) uses
  // this instead of the throttled `currentTimeSec` state.
  const currentTimeSecRef = useRef(0);
  const isPlayingRef = useRef(false);
  const lastUiFrameUpdateRef = useRef(0);

  const isFirstPersist = useRef(true);

  // Skips its own first run so the mount-time load below (which changes
  // `layout` from DEFAULT_LAYOUT to the stored value) can't be raced by
  // this effect writing DEFAULT_LAYOUT back over the stored value.
  useEffect(() => {
    if (isFirstPersist.current) {
      isFirstPersist.current = false;
      return;
    }
    try {
      window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // Best-effort only — a full/blocked localStorage just means the
      // panel sizes won't persist across reloads.
    }
  }, [layout]);

  // Runs after hydration so the first client render still matches the
  // server's DEFAULT_LAYOUT — reading localStorage during render (e.g. via
  // a useState lazy initializer) would cause a hydration mismatch.
  useEffect(() => {
    setLayout(loadLayout());
  }, []);

  const resizeMediaPanel = (dx: number) =>
    setLayout((l) => ({ ...l, mediaPanelWidth: clamp(l.mediaPanelWidth + dx, 180, 480) }));
  const resizeInspector = (dx: number) =>
    setLayout((l) => ({ ...l, inspectorWidth: clamp(l.inspectorWidth - dx, 240, 480) }));
  const resizeTimeline = (dy: number) =>
    setLayout((l) => ({ ...l, timelineHeight: clamp(l.timelineHeight - dy, 140, 560) }));

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onFrame = (e: { detail: { frame: number } }) => {
      const sec = e.detail.frame / edl.fps;
      currentTimeSecRef.current = sec;
      if (!isPlayingRef.current) {
        setCurrentTimeSec(sec);
        return;
      }
      const now = performance.now();
      if (now - lastUiFrameUpdateRef.current < PLAYBACK_UI_THROTTLE_MS) return;
      lastUiFrameUpdateRef.current = now;
      setCurrentTimeSec(sec);
    };
    const onPlay = () => {
      isPlayingRef.current = true;
      setIsPlaying(true);
    };
    const onPause = () => {
      isPlayingRef.current = false;
      // Playback just stopped mid-throttle-window — flush the exact
      // position immediately rather than leaving the UI up to
      // PLAYBACK_UI_THROTTLE_MS stale until the next tick (there won't be
      // one; the Player isn't emitting frameupdate while paused).
      setCurrentTimeSec(currentTimeSecRef.current);
      setIsPlaying(false);
    };
    const onFullscreenChange = (e: { detail: { isFullscreen: boolean } }) =>
      setIsFullscreen(e.detail.isFullscreen);
    player.addEventListener("frameupdate", onFrame);
    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    player.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      player.removeEventListener("frameupdate", onFrame);
      player.removeEventListener("play", onPlay);
      player.removeEventListener("pause", onPause);
      player.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, [edl.fps]);

  // Prewarms the preview-proxy transcode for every video source the EDL
  // currently references, as soon as it's known — instead of waiting for
  // the Player's own Sequence to premount and request it right as playback
  // reaches that clip. /preview-proxy blocks on ffmpeg the first time it's
  // asked for a source (see previewMedia.ts), so without this, hitting a
  // not-yet-cached clip mid-playback stalls the video element until the
  // transcode finishes. `warmed` tracks what's already been requested so an
  // unrelated edit (a new `edl` object on every accepted op) doesn't
  // re-request sources that are already cached or in flight.
  const warmedPreviewSources = useRef<Set<string>>(new Set());
  useEffect(() => {
    const sources = new Set<string>();
    for (const v of edl.video) sources.add(v.src);
    for (const seg of edl.video) if (seg.fgSrc) sources.add(seg.fgSrc);
    // Voice lines go through the same proxy (EdlVideo's voiceovers).
    for (const v of edl.voiceovers) sources.add(v.src);
    for (const o of edl.overlays) {
      if (
        (o.component === "VideoOverlay" || o.component === "CutawayOverlay") &&
        typeof o.params.src === "string"
      ) {
        sources.add(o.params.src);
      }
    }
    for (const src of sources) {
      if (warmedPreviewSources.current.has(src)) continue;
      warmedPreviewSources.current.add(src);
      fetch(`/api/jobs/${jobId}/preview-proxy?src=${encodeURIComponent(src)}`, { redirect: "manual" }).catch(() => {
        // Best-effort warmup only — a failed prefetch just means the
        // Player's own request (still guaranteed later) does the work.
        warmedPreviewSources.current.delete(src);
      });
    }
  }, [jobId, edl.video, edl.overlays, edl.voiceovers]);

  // Refreshed on mount, right before the Export panel (where Render lives)
  // opens, and right after a render attempt is actually recorded (see
  // RenderPanel's own onQuotaChange call) — a build/render attempt is
  // recorded the instant the request is accepted, not when it finishes (see
  // quota.ts's own doc comment), so that's the moment this should re-check,
  // not render completion.
  const fetchQuota = useCallback(() => {
    fetch("/api/quota")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: QuotaStatus | null) => {
        if (data) setQuota(data);
      })
      .catch(() => {
        // Decorative indicator only — a failed fetch just leaves the last
        // known value (or nothing) shown.
      });
  }, []);

  useEffect(() => {
    fetchQuota();
  }, [fetchQuota]);

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

  // Uploads a user-supplied file and wires it into the timeline in one
  // round trip (see /api/jobs/[jobId]/timeline/media) — same undo/redo
  // bookkeeping as submitOp, since "add music" is just another edit.
  // `placement` is where a file dropped straight onto the timeline lands
  // (the Timeline's own drop resolver decided it); the media panel's
  // Import leaves it empty and the route's defaults apply.
  const uploadMedia = useCallback(
    async (file: File, kind: MediaKind, atSec: number, placement: UploadPlacement = {}): Promise<boolean> => {
      setPending(true);
      setError(null);
      try {
        const body = new FormData();
        body.append("file", file);
        body.append("kind", kind);
        body.append("atSec", String(atSec));
        if (placement.trackId) body.append("trackId", placement.trackId);
        if (placement.newTrack) body.append("newTrack", "true");
        if (placement.atIndex !== undefined) body.append("atIndex", String(placement.atIndex));
        const res = await fetch(`/api/jobs/${jobId}/timeline/media`, { method: "POST", body });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "upload failed");
        setUndoStack((s) => [...s.slice(-(MAX_HISTORY - 1)), edl]);
        setRedoStack([]);
        setEdl(data.edl as Edl);
        return true;
      } catch (err) {
        setError((err as Error).message);
        return false;
      } finally {
        setPending(false);
      }
    },
    [jobId, edl],
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
        e.preventDefault();
        submitOp(
          selection.track === "voice"
            ? { type: "voiceDelete", ids: selection.ids }
            : { type: "deleteMany", track: selection.track, ids: selection.ids },
        );
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

  // ── Regenerate one clip (AI videos) ─────────────────────────────────
  // The server makes the new take and swaps it into edl.json itself (see
  // api/jobs/[jobId]/regenerate-clip); this asks the price first, then polls
  // and loads the swapped document, pushing the old one onto undo so the
  // previous take is one ⌘Z away.
  const [regenBusy, setRegenBusy] = useState<string[]>([]);

  const loadServerEdl = useCallback(async () => {
    const res = await fetch(`/api/jobs/${jobId}/edl`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "could not reload the timeline");
    return data.edl as Edl;
  }, [jobId]);

  // With a planId (the shot chat's Generate), the price was already shown on
  // the button that was pressed, so there is no second confirmation.
  const regenerateClip = useCallback(
    async (clipId: string, planId?: string) => {
      setError(null);
      try {
        if (!planId) {
          const quote = await fetch(`/api/jobs/${jobId}/regenerate-clip`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clipId }),
          });
          const q = await quote.json();
          if (!quote.ok) throw new Error(q.error ?? "could not price the new take");
          const ok = window.confirm(
            `Make a new AI take of this shot?\n\nIt costs about $${Number(q.estimateUsd).toFixed(2)} and takes a few minutes. Only this clip changes; your other edits stay, and undo brings the old take back.`,
          );
          if (!ok) return;
        }
        const start = await fetch(`/api/jobs/${jobId}/regenerate-clip`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clipId, confirm: true, planId }),
        });
        if (!start.ok) throw new Error((await start.json()).error ?? "could not start the new take");
        setRegenBusy((b) => (b.includes(clipId) ? b : [...b, clipId]));
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [jobId],
  );

  // Picks up takes already running when the page (re)loads.
  useEffect(() => {
    if (!aiVideo) return;
    fetch(`/api/jobs/${jobId}/regenerate-clip`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { clips: Record<string, RegenStatus> } | null) => {
        if (!data) return;
        const running = Object.entries(data.clips).filter(([, s]) => s.status === "running").map(([id]) => id);
        if (running.length) setRegenBusy(running);
      })
      .catch(() => {
        // Nothing to resume is the common case; a failed check just means
        // a take that is still running won't show its spinner.
      });
  }, [aiVideo, jobId]);

  const edlRef = useRef(edl);
  edlRef.current = edl;
  useEffect(() => {
    if (regenBusy.length === 0) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}/regenerate-clip`);
        if (!res.ok) return;
        const { clips } = (await res.json()) as { clips: Record<string, RegenStatus> };
        const finished = regenBusy.filter((id) => clips[id] && clips[id].status !== "running");
        if (finished.length === 0) return;
        const failed = finished.map((id) => clips[id]).find((c) => c.status === "error");
        if (failed) setError(`Regenerate failed: ${failed.error ?? "unknown error"}`);
        if (finished.some((id) => clips[id].status === "done")) {
          const next = await loadServerEdl();
          setUndoStack((st) => [...st.slice(-(MAX_HISTORY - 1)), edlRef.current]);
          setRedoStack([]);
          setEdl(next);
        }
        setRegenBusy((b) => b.filter((id) => !finished.includes(id)));
      } catch {
        // A missed poll is retried on the next tick.
      }
    }, REGEN_POLL_MS);
    return () => clearInterval(timer);
  }, [regenBusy, jobId, loadServerEdl]);

  // Free and instant: the take's file already exists, it just goes back on
  // the timeline. Undoable like any edit. `choice` is a take, or the raw clip
  // with its own audio (which also takes the ElevenLabs lines out from under it).
  const chooseTake = useCallback(
    async (clipId: string, choice: { takeId: string } | { audio: "raw" }) => {
      setPending(true);
      setError(null);
      try {
        const res = await fetch(`/api/jobs/${jobId}/clip-takes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clipId, ...choice }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "could not switch takes");
        setUndoStack((st) => [...st.slice(-(MAX_HISTORY - 1)), edlRef.current]);
        setRedoStack([]);
        setEdl(data.edl as Edl);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setPending(false);
      }
    },
    [jobId],
  );

  const videoExtras = useCallback(
    (clip: Edl["video"][number]) => (
      <>
        <ClipTakes
          jobId={jobId}
          clipId={clip.id}
          currentSrc={clip.src}
          busy={regenBusy.includes(clip.id)}
          onChoose={(takeId) => chooseTake(clip.id, { takeId })}
          onUseRawAudio={() => chooseTake(clip.id, { audio: "raw" })}
          onNewTake={() => regenerateClip(clip.id)}
        />
        <ShotChat
          jobId={jobId}
          clipId={clip.id}
          currentSrc={clip.src}
          busy={regenBusy.includes(clip.id)}
          onGenerate={(planId) => regenerateClip(clip.id, planId)}
        />
      </>
    ),
    [jobId, regenBusy, chooseTake, regenerateClip],
  );

  const regenerateProp = useMemo(
    () => (aiVideo ? { busyIds: regenBusy, onRegenerate: regenerateClip } : undefined),
    [aiVideo, regenBusy, regenerateClip],
  );

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
            href={backHref ?? `/jobs/${jobId}/resources`}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[color:var(--ed-ink-dim)] transition-colors hover:bg-[color:var(--ed-raised)] hover:text-[color:var(--ed-ink)]"
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </Link>
          <div className="h-5 w-px bg-[color:var(--ed-border-strong)]" />
          <div>
            <p className="font-[family-name:var(--ed-font-display)] text-sm font-semibold text-[color:var(--ed-ink)]">
              {formatName}
            </p>
            <p className="font-mono text-[10px] tracking-wide text-[color:var(--ed-ink-faint)]">{subtitle ?? jobId}</p>
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
          {!aiVideo && quota && !quota.unlimited && (
            <span className="flex items-center gap-1.5 rounded-full border border-[color:var(--ed-border)] px-2.5 py-1 text-[11px] text-[color:var(--ed-ink-dim)]">
              {quota.remaining} video{quota.remaining === 1 ? "" : "s"} left today
            </span>
          )}
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
              onClick={() => {
                setExportOpen((v) => !v);
                fetchQuota();
              }}
              className="rounded-lg bg-[color:var(--ed-accent)] px-4 py-2 font-[family-name:var(--ed-font-display)] text-sm font-semibold text-[color:var(--ed-accent-ink)] transition-transform hover:scale-[1.02] active:scale-[0.98]"
            >
              Export
            </button>
            {exportOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
                <div className="absolute top-11 right-0 z-50 w-96">
                  <RenderPanel jobId={jobId} onQuotaChange={fetchQuota} />
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
            <MediaPanel
              edl={edl}
              onJumpTo={jumpTo}
              onUpload={uploadMedia}
              onOp={submitOp}
              currentTimeSecRef={currentTimeSecRef}
              pending={pending}
            />
          </div>
          <ResizeHandle orientation="vertical" onResize={resizeMediaPanel} />

          <div className={`flex min-w-0 flex-1 flex-col ${panelClass}`}>
            <div className="flex flex-1 items-center justify-center overflow-hidden bg-black p-6">
              <div
                className="relative h-full max-h-full"
                style={{ aspectRatio: `${edl.width} / ${edl.height}` }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(TEXT_OVERLAY_DRAG_TYPE)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                }}
                onDrop={(e) => {
                  if (!e.dataTransfer.types.includes(TEXT_OVERLAY_DRAG_TYPE)) return;
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const x = (e.clientX - rect.left) / rect.width;
                  const y = (e.clientY - rect.top) / rect.height;
                  submitOp(buildAddTextOverlayOp(currentTimeSec, { x, y }));
                }}
              >
                <Player
                  ref={playerRef}
                  component={EdlVideo}
                  inputProps={playerInputProps}
                  durationInFrames={totalFrames}
                  fps={edl.fps}
                  compositionWidth={edl.width}
                  compositionHeight={edl.height}
                  numberOfSharedAudioTags={24}
                  style={{ width: "100%", height: "100%" }}
                  loop
                />
                <OverlayCanvas
                  edl={edl}
                  selection={selection}
                  currentTimeSec={currentTimeSec}
                  onSelect={setSelection}
                  onOp={submitOp}
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
              <TransportButton
                onClick={() =>
                  isFullscreen ? playerRef.current?.exitFullscreen() : playerRef.current?.requestFullscreen()
                }
                title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              >
                {isFullscreen ? <CollapseIcon className="h-4 w-4" /> : <ExpandIcon className="h-4 w-4" />}
              </TransportButton>
            </div>
          </div>

          <ResizeHandle orientation="vertical" onResize={resizeInspector} />
          <div style={{ width: layout.inspectorWidth }} className={`shrink-0 ${panelClass}`}>
            <Inspector
              key={selection ? `${selection.track}:${selection.ids.join(",")}` : "none"}
              edl={edl}
              selection={selection}
              currentTimeSec={currentTimeSec}
              onOp={submitOp}
              onDeselect={() => setSelection(null)}
              videoExtras={aiVideo ? videoExtras : undefined}
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
            onUpload={uploadMedia}
            regenerate={regenerateProp}
          />
        </div>
      </div>
    </div>
  );
}

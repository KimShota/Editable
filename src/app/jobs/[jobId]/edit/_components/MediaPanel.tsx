"use client";

import { memo, useRef, useState } from "react";
import type { Edl } from "@backend/pipeline/types";
import type { TimelineOp } from "@backend/pipeline/timelineOps";
import { Selection, MediaKind } from "./selection";
import { MusicNoteIcon, VolumeIcon, PlusIcon } from "./Icons";
import { TEXT_OVERLAY_DRAG_TYPE, buildAddTextOverlayOp } from "./textOverlay";

type Tab = "media" | "audio" | "text";

const tabClass = (active: boolean) =>
  `flex-1 py-2.5 text-xs tracking-wide uppercase transition-colors ${
    active
      ? "border-b-2 border-[color:var(--ed-accent)] text-[color:var(--ed-ink)]"
      : "text-[color:var(--ed-ink-dim)] hover:text-[color:var(--ed-ink)]"
  }`;

const cardClass =
  "rounded-lg border border-[color:var(--ed-border-strong)] bg-[color:var(--ed-raised)] text-left transition-colors hover:border-[color:var(--ed-accent)]/50";

const addButtonClass =
  "flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-[color:var(--ed-border-strong)] px-2.5 py-2 text-xs text-[color:var(--ed-ink-dim)] transition-colors hover:border-[color:var(--ed-accent)]/50 hover:text-[color:var(--ed-ink)] disabled:pointer-events-none disabled:opacity-40";

/** One Import for every kind of visual media, CapCut-style — which layer a
 *  file lands on follows from the file itself rather than from which
 *  button was pressed. A video extends the main footage track; an image
 *  has no duration of its own so it can only ever be an overlay (given a
 *  default span — see IMAGE_OVERLAY_DEFAULT_SEC in the media route).
 *  Returns null for a file that's neither, so the caller ignores it
 *  instead of guessing a kind. */
const resolveImportKind = (file: File): MediaKind | null =>
  file.type.startsWith("video/") ? "video" : file.type.startsWith("image/") ? "overlayImage" : null;

/** A poster frame for a video asset — the media cards show these instead
 *  of mounting a live <video> each (see the preview-thumbnail route). */
const thumbnailUrl = (jobId: string, src: string, atSec: number) =>
  `/api/jobs/${jobId}/preview-thumbnail?src=${encodeURIComponent(src)}&t=${atSec}`;

/** One (hidden file input + button) pair for uploading media. Also doubles
 *  as this tab's drop target: dragging a file from the OS anywhere onto
 *  the button uploads it the same way a click would. `kind` is fixed for
 *  a single-purpose button (e.g. the main video track); `resolveKind`
 *  lets one button accept several file types and pick the kind per-file
 *  (e.g. the unified image/video overlay import) — a file `resolveKind`
 *  rejects (returns null) is silently ignored rather than guessed at. */
const AddButton = ({
  label,
  accept,
  kind,
  resolveKind,
  onUpload,
  disabled,
}: {
  label: string;
  accept: string;
  kind?: MediaKind;
  resolveKind?: (file: File) => MediaKind | null;
  onUpload: (file: File, kind: MediaKind) => void;
  disabled: boolean;
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const resolve = (file: File): MediaKind | null => kind ?? resolveKind?.(file) ?? null;
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          const resolved = file && resolve(file);
          if (file && resolved) onUpload(file, resolved);
        }}
        className={`${addButtonClass} ${dragOver ? "border-[color:var(--ed-accent)] text-[color:var(--ed-ink)]" : ""}`}
      >
        <PlusIcon className="h-3.5 w-3.5" />
        {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          const resolved = file && resolve(file);
          if (file && resolved) onUpload(file, resolved);
          e.target.value = "";
        }}
      />
    </>
  );
};

/** The Text tab's one control: creates a TextOverlay. A plain click drops
 *  it centered on the frame at the current playhead; dragging it onto the
 *  preview or the timeline (their own onDrop handlers key off
 *  TEXT_OVERLAY_DRAG_TYPE) places it at the exact drop position/time
 *  instead. */
const AddTextButton = ({
  disabled,
  currentTimeSec,
  onOp,
}: {
  disabled: boolean;
  currentTimeSec: number;
  onOp: (op: TimelineOp) => void;
}) => (
  <button
    type="button"
    draggable={!disabled}
    disabled={disabled}
    onClick={() => onOp(buildAddTextOverlayOp(currentTimeSec))}
    onDragStart={(e) => {
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData(TEXT_OVERLAY_DRAG_TYPE, "1");
    }}
    className={addButtonClass}
  >
    <PlusIcon className="h-3.5 w-3.5" />
    Add text
  </button>
);

/** Reflects the job's own bound assets, plus lets the user pull in their
 *  own files — via click-to-browse or drag-and-drop, each wired straight
 *  into the timeline at the current playhead (see
 *  /api/jobs/[jobId]/timeline/media). Clicking an existing item jumps the
 *  timeline/player to it.
 *
 *  One tab per kind of thing, one Import apiece: Media holds all visual
 *  media (footage and the images/videos overlaid on it — an overlay is
 *  just media on a higher layer, see mediaItems below), Audio holds every
 *  audio clip regardless of whether it's a bed or a one-shot. Text is the
 *  odd one out — no file to import, just "Add text", clicked or dragged
 *  onto the preview/timeline to place it (see textOverlay.ts).
 *
 *  Memoized: doesn't depend on playhead position for its OWN render (the
 *  playhead is only read at upload time via a ref-free prop), so it
 *  shouldn't re-render on every one of the editor's ~30/sec frame updates. */
export const MediaPanel = memo(function MediaPanel({
  edl,
  onJumpTo,
  onUpload,
  onOp,
  currentTimeSec,
  pending,
}: {
  edl: Edl;
  onJumpTo: (selection: Selection, tlInSec: number) => void;
  onUpload: (file: File, kind: MediaKind, atSec: number) => Promise<boolean>;
  onOp: (op: TimelineOp) => void;
  currentTimeSec: number;
  pending: boolean;
}) {
  const [tab, setTab] = useState<Tab>("media");
  const upload = (file: File, kind: MediaKind) => {
    void onUpload(file, kind, currentTimeSec);
  };

  /** Every piece of visual media the job holds, as ONE uniform list: the
   *  main-track footage and the images/videos layered over it. An overlay
   *  is just an image or a video that happens to sit on a higher layer —
   *  nothing about the file itself is different — so they're drawn
   *  identically here (thumbnail, name, when) rather than split into
   *  their own section with component-name labels. Layering is a timeline
   *  concern, and the timeline is where it's already visible. Text
   *  overlays are excluded: they aren't files, and the Text tab owns them. */
  const mediaItems = [
    ...edl.video.map((v) => ({
      key: v.id,
      selection: { track: "video" as const, ids: [v.id] },
      tlInSec: v.tlInSec,
      label: v.blockId,
      sublabel: `${(v.tlOutSec - v.tlInSec).toFixed(1)}s`,
      thumbSrc: thumbnailUrl(edl.jobId, v.src, v.srcInSec + (v.srcOutSec - v.srcInSec) / 2),
    })),
    ...edl.overlays
      .filter((o) => o.component !== "TextOverlay")
      .map((o) => {
        const src = typeof o.params.src === "string" ? o.params.src : "";
        return {
          key: o.id,
          selection: { track: "overlay" as const, ids: [o.id] },
          tlInSec: o.tlInSec,
          label: src.split("/").pop() ?? o.component,
          sublabel: `at ${o.tlInSec.toFixed(1)}s`,
          // An image is its own thumbnail; a video needs a poster frame
          // rendered off it, same as the footage cards above.
          thumbSrc: o.component === "ImageOverlay" ? `/${src}` : thumbnailUrl(edl.jobId, src, 0),
        };
      }),
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="flex border-b border-[color:var(--ed-border)]">
        <button onClick={() => setTab("media")} className={tabClass(tab === "media")}>
          Media
        </button>
        <button onClick={() => setTab("audio")} className={tabClass(tab === "audio")}>
          Audio
        </button>
        <button onClick={() => setTab("text")} className={tabClass(tab === "text")}>
          Text
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {tab === "media" && (
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2">
              <AddButton
                label="Import"
                accept="video/*,image/*"
                resolveKind={resolveImportKind}
                onUpload={upload}
                disabled={pending}
              />
            </div>
            {mediaItems.map((m) => (
              <button key={m.key} onClick={() => onJumpTo(m.selection, m.tlInSec)} className={cardClass}>
                <div className="aspect-9/16 overflow-hidden rounded-t-lg bg-black/40">
                  {/* A static poster frame, not a live <video> — 16+ of
                      those mounted at once competed with the Player for
                      decoders and were a chunk of the editor's jank. */}
                  <img src={m.thumbSrc} alt="" loading="lazy" className="h-full w-full object-cover" />
                </div>
                <div className="p-1.5">
                  <p className="truncate text-[11px] text-[color:var(--ed-ink)]">{m.label}</p>
                  <p className="text-[10px] tabular-nums text-[color:var(--ed-ink-dim)]">{m.sublabel}</p>
                </div>
              </button>
            ))}
          </div>
        )}

        {tab === "audio" && (
          <div className="flex flex-col gap-2">
            <AddButton label="Import" accept="audio/*" kind="music" onUpload={upload} disabled={pending} />
            {edl.music.map((m) => (
              <button
                key={m.id}
                onClick={() => onJumpTo({ track: "music", ids: [m.id] }, m.tlInSec)}
                className={`flex items-center gap-2.5 p-2 ${cardClass}`}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[color:var(--ed-accent-dim)] text-[color:var(--ed-accent)]">
                  <MusicNoteIcon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[11px] text-[color:var(--ed-ink)]">{m.src.split("/").pop()}</p>
                  <p className="text-[10px] text-[color:var(--ed-ink-dim)]">Music bed</p>
                </div>
              </button>
            ))}
            {edl.sfx.map((s) => (
              <button
                key={s.id}
                onClick={() => onJumpTo({ track: "sfx", ids: [s.id] }, s.tlInSec)}
                className={`flex items-center gap-2.5 p-2 ${cardClass}`}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[color:var(--ed-accent-dim)] text-[color:var(--ed-accent)]">
                  <VolumeIcon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[11px] text-[color:var(--ed-ink)]">{s.src.split("/").pop()}</p>
                  <p className="text-[10px] tabular-nums text-[color:var(--ed-ink-dim)]">at {s.tlInSec.toFixed(1)}s</p>
                </div>
              </button>
            ))}
            {edl.music.length === 0 && edl.sfx.length === 0 && (
              <p className="text-xs text-[color:var(--ed-ink-dim)]">No audio elements.</p>
            )}
          </div>
        )}

        {/* Just the one control — existing text lives on the timeline,
            where it's already clickable, so listing it again here would
            only duplicate it. */}
        {tab === "text" && <AddTextButton disabled={pending} currentTimeSec={currentTimeSec} onOp={onOp} />}
      </div>
    </div>
  );
});

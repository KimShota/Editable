"use client";

import { memo, useRef, useState } from "react";
import type { Edl } from "@backend/pipeline/types";
import { Selection, MediaKind } from "./selection";
import { MusicNoteIcon, VolumeIcon, PlusIcon } from "./Icons";

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

/** One (hidden file input + button) pair for uploading a given MediaKind.
 *  Also doubles as this tab's drop target: dragging a file of the right
 *  type from the OS anywhere onto the button uploads it the same way a
 *  click would. */
const AddButton = ({
  label,
  accept,
  kind,
  onUpload,
  disabled,
}: {
  label: string;
  accept: string;
  kind: MediaKind;
  onUpload: (file: File, kind: MediaKind) => void;
  disabled: boolean;
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
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
          if (file) onUpload(file, kind);
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
          if (file) onUpload(file, kind);
          e.target.value = "";
        }}
      />
    </>
  );
};

/** Reflects the job's own bound assets, plus lets the user pull in their
 *  own files — a music bed, a sound effect, an image/video overlay, or an
 *  extra video clip — via click-to-browse or drag-and-drop, each wired
 *  straight into the timeline at the current playhead (see
 *  /api/jobs/[jobId]/timeline/media). Clicking an existing item jumps the
 *  timeline/player to it.
 *
 *  Memoized: doesn't depend on playhead position for its OWN render (the
 *  playhead is only read at upload time via a ref-free prop), so it
 *  shouldn't re-render on every one of the editor's ~30/sec frame updates. */
export const MediaPanel = memo(function MediaPanel({
  edl,
  onJumpTo,
  onUpload,
  currentTimeSec,
  pending,
}: {
  edl: Edl;
  onJumpTo: (selection: Selection, tlInSec: number) => void;
  onUpload: (file: File, kind: MediaKind, atSec: number) => Promise<boolean>;
  currentTimeSec: number;
  pending: boolean;
}) {
  const [tab, setTab] = useState<Tab>("media");
  const upload = (file: File, kind: MediaKind) => {
    void onUpload(file, kind, currentTimeSec);
  };

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
                label="Add video clip"
                accept="video/*"
                kind="video"
                onUpload={upload}
                disabled={pending}
              />
            </div>
            {edl.video.map((v) => {
              const posterAtSec = v.srcInSec + (v.srcOutSec - v.srcInSec) / 2;
              const thumbSrc = `/api/jobs/${edl.jobId}/preview-thumbnail?src=${encodeURIComponent(v.src)}&t=${posterAtSec}`;
              return (
              <button key={v.id} onClick={() => onJumpTo({ track: "video", ids: [v.id] }, v.tlInSec)} className={cardClass}>
                <div className="aspect-9/16 overflow-hidden rounded-t-lg bg-black/40">
                  {/* A static poster frame, not a live <video> — 16+ of
                      those mounted at once competed with the Player for
                      decoders and were a chunk of the editor's jank. */}
                  <img src={thumbSrc} alt="" loading="lazy" className="h-full w-full object-cover" />
                </div>
                <div className="p-1.5">
                  <p className="truncate text-[11px] text-[color:var(--ed-ink)]">{v.blockId}</p>
                  <p className="text-[10px] tabular-nums text-[color:var(--ed-ink-dim)]">
                    {(v.tlOutSec - v.tlInSec).toFixed(1)}s
                  </p>
                </div>
              </button>
              );
            })}
          </div>
        )}

        {tab === "audio" && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              <AddButton label="Add music" accept="audio/*" kind="music" onUpload={upload} disabled={pending} />
              <AddButton label="Add sound effect" accept="audio/*" kind="sfx" onUpload={upload} disabled={pending} />
            </div>
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

        {tab === "text" && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              <AddButton
                label="Add image overlay"
                accept="image/*"
                kind="overlayImage"
                onUpload={upload}
                disabled={pending}
              />
              <AddButton
                label="Add video overlay"
                accept="video/*"
                kind="overlayVideo"
                onUpload={upload}
                disabled={pending}
              />
            </div>
            {edl.overlays.map((o) => (
              <button
                key={o.id}
                onClick={() => onJumpTo({ track: "overlay", ids: [o.id] }, o.tlInSec)}
                className={`p-2 ${cardClass}`}
              >
                <p className="truncate text-[11px] text-[color:var(--ed-ink)]">
                  {typeof o.params.text === "string" ? o.params.text : o.component}
                </p>
                <p className="text-[10px] tabular-nums text-[color:var(--ed-ink-dim)]">
                  {o.component} · at {o.tlInSec.toFixed(1)}s
                </p>
              </button>
            ))}
            {edl.overlays.length === 0 && <p className="text-xs text-[color:var(--ed-ink-dim)]">No text overlays.</p>}
          </div>
        )}
      </div>
    </div>
  );
});

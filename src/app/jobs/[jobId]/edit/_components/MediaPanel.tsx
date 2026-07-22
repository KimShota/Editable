"use client";

import { memo, useState } from "react";
import type { Edl } from "@backend/pipeline/types";
import { Selection, MUSIC_ID } from "./selection";
import { MusicNoteIcon, VolumeIcon } from "./Icons";

type Tab = "media" | "audio" | "text";

const tabClass = (active: boolean) =>
  `flex-1 py-2.5 text-xs tracking-wide uppercase transition-colors ${
    active
      ? "border-b-2 border-[color:var(--ed-accent)] text-[color:var(--ed-ink)]"
      : "text-[color:var(--ed-ink-dim)] hover:text-[color:var(--ed-ink)]"
  }`;

const cardClass =
  "rounded-lg border border-[color:var(--ed-border-strong)] bg-[color:var(--ed-raised)] text-left transition-colors hover:border-[color:var(--ed-accent)]/50";

/** Read-only reflection of the job's own bound assets — not a stock
 *  library. Clicking an item jumps the timeline/player to it. Dragging new
 *  media onto the timeline isn't wired up yet (see README follow-ups).
 *
 *  Memoized: doesn't depend on playhead position, so it shouldn't re-render
 *  on every one of the editor's ~30/sec frame updates. */
export const MediaPanel = memo(function MediaPanel({
  edl,
  onJumpTo,
}: {
  edl: Edl;
  onJumpTo: (selection: Selection, tlInSec: number) => void;
}) {
  const [tab, setTab] = useState<Tab>("media");

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
            {edl.video.map((v) => {
              const posterAtSec = v.srcInSec + (v.srcOutSec - v.srcInSec) / 2;
              const thumbSrc = `/api/jobs/${edl.jobId}/preview-thumbnail?src=${encodeURIComponent(v.src)}&t=${posterAtSec}`;
              return (
              <button key={v.id} onClick={() => onJumpTo({ track: "video", id: v.id }, v.tlInSec)} className={cardClass}>
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
            {edl.music && (
              <button
                onClick={() => onJumpTo({ track: "music", id: MUSIC_ID }, 0)}
                className={`flex items-center gap-2.5 p-2 ${cardClass}`}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[color:var(--ed-accent-dim)] text-[color:var(--ed-accent)]">
                  <MusicNoteIcon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[11px] text-[color:var(--ed-ink)]">{edl.music.src.split("/").pop()}</p>
                  <p className="text-[10px] text-[color:var(--ed-ink-dim)]">Music bed</p>
                </div>
              </button>
            )}
            {edl.sfx.map((s) => (
              <button
                key={s.id}
                onClick={() => onJumpTo({ track: "sfx", id: s.id }, s.tlInSec)}
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
            {!edl.music && edl.sfx.length === 0 && (
              <p className="text-xs text-[color:var(--ed-ink-dim)]">No audio elements.</p>
            )}
          </div>
        )}

        {tab === "text" && (
          <div className="flex flex-col gap-2">
            {edl.overlays.map((o) => (
              <button
                key={o.id}
                onClick={() => onJumpTo({ track: "overlay", id: o.id }, o.tlInSec)}
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

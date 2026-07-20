"use client";

import type { Edl } from "@backend/pipeline/types";
import type { TimelineOp } from "@backend/pipeline/timelineOps";
import { Selection } from "./selection";

const TRANSITIONS = [
  { value: "cut", label: "Cut" },
  { value: "fade", label: "Fade" },
  { value: "whooshZoom", label: "Whoosh zoom" },
];

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-1.5">
    <label className="text-[11px] tracking-wide text-[color:var(--ink-dim)] uppercase">{label}</label>
    {children}
  </div>
);

const inputClass =
  "w-full rounded-lg border border-white/12 bg-black/30 px-2.5 py-1.5 text-sm text-[color:var(--ink)] outline-none focus:border-[color:var(--accent)]";

export function Inspector({
  edl,
  selection,
  currentTimeSec,
  onOp,
  onDeselect,
}: {
  edl: Edl;
  selection: Selection;
  currentTimeSec: number;
  onOp: (op: TimelineOp) => void;
  onDeselect: () => void;
}) {
  if (!selection) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm text-[color:var(--ink-dim)]">Select a clip on the timeline to edit it.</p>
      </div>
    );
  }

  const header = (title: string, subtitle?: string) => (
    <div className="flex items-center justify-between border-b border-white/8 p-4">
      <div className="min-w-0">
        <p className="truncate font-[family-name:var(--font-display)] text-sm font-bold text-[color:var(--ink)]">
          {title}
        </p>
        {subtitle && <p className="truncate text-xs text-[color:var(--ink-dim)]">{subtitle}</p>}
      </div>
      <button onClick={onDeselect} className="text-xs text-[color:var(--ink-dim)] hover:text-[color:var(--ink)]">
        ✕
      </button>
    </div>
  );

  if (selection.track === "video") {
    const clip = edl.video.find((v) => v.id === selection.id);
    if (!clip) return null;
    const isLast = edl.video[edl.video.length - 1].id === clip.id;
    const transition = edl.transitions.find((t) => t.afterClipId === clip.id);
    const canSplit = currentTimeSec > clip.tlInSec + 0.1 && currentTimeSec < clip.tlOutSec - 0.1;

    return (
      <div className="flex h-full flex-col">
        {header("Video clip", clip.blockId)}
        <div className="flex flex-col gap-4 overflow-y-auto p-4">
          <Field label="Timeline position">
            <p className="text-sm text-[color:var(--ink)]">
              {clip.tlInSec.toFixed(2)}s – {clip.tlOutSec.toFixed(2)}s
              <span className="text-[color:var(--ink-dim)]"> ({(clip.tlOutSec - clip.tlInSec).toFixed(2)}s)</span>
            </p>
          </Field>
          <Field label="Source range">
            <p className="text-sm text-[color:var(--ink)]">
              {clip.srcInSec.toFixed(2)}s – {clip.srcOutSec.toFixed(2)}s
              {clip.srcDurationSec !== undefined && (
                <span className="text-[color:var(--ink-dim)]"> of {clip.srcDurationSec.toFixed(2)}s source</span>
              )}
            </p>
          </Field>
          <label className="flex items-center gap-2 text-sm text-[color:var(--ink)]">
            <input
              type="checkbox"
              checked={clip.muted}
              onChange={(e) =>
                onOp({ type: "setProp", track: "video", id: clip.id, patch: { muted: e.target.checked } })
              }
            />
            Muted
          </label>

          {!isLast && (
            <Field label="Transition after this clip">
              <select
                value={transition?.component ?? "cut"}
                onChange={(e) =>
                  onOp({ type: "setProp", track: "transition", id: clip.id, patch: { component: e.target.value } })
                }
                className={inputClass}
              >
                {TRANSITIONS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <div className="mt-2 flex flex-col gap-2 border-t border-white/8 pt-4">
            <button
              disabled={!canSplit}
              onClick={() => onOp({ type: "split", track: "video", id: clip.id, atSec: currentTimeSec })}
              className="rounded-lg border border-white/12 px-3 py-2 text-sm text-[color:var(--ink)] hover:border-[color:var(--accent)]/50 disabled:opacity-30"
            >
              Split at playhead
            </button>
            <button
              disabled={edl.video.length <= 1}
              onClick={() => onOp({ type: "delete", track: "video", id: clip.id })}
              className="rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 disabled:opacity-30"
            >
              Delete clip
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (selection.track === "overlay") {
    const clip = edl.overlays.find((o) => o.id === selection.id);
    if (!clip) return null;
    const canSplit = currentTimeSec > clip.tlInSec + 0.1 && currentTimeSec < clip.tlOutSec - 0.1;
    const hasText = typeof clip.params.text === "string";

    return (
      <div className="flex h-full flex-col">
        {header("Overlay", clip.component)}
        <div className="flex flex-col gap-4 overflow-y-auto p-4">
          <Field label="Timeline position">
            <p className="text-sm text-[color:var(--ink)]">
              {clip.tlInSec.toFixed(2)}s – {clip.tlOutSec.toFixed(2)}s
            </p>
          </Field>
          {hasText && (
            <Field label="Text">
              <textarea
                defaultValue={clip.params.text as string}
                onBlur={(e) =>
                  onOp({
                    type: "setProp",
                    track: "overlay",
                    id: clip.id,
                    patch: { params: { text: e.target.value } },
                  })
                }
                rows={3}
                className={inputClass}
              />
            </Field>
          )}
          <div className="mt-2 flex flex-col gap-2 border-t border-white/8 pt-4">
            <button
              disabled={!canSplit}
              onClick={() => onOp({ type: "split", track: "overlay", id: clip.id, atSec: currentTimeSec })}
              className="rounded-lg border border-white/12 px-3 py-2 text-sm text-[color:var(--ink)] hover:border-[color:var(--accent)]/50 disabled:opacity-30"
            >
              Split at playhead
            </button>
            <button
              onClick={() => onOp({ type: "delete", track: "overlay", id: clip.id })}
              className="rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-400 hover:bg-red-500/10"
            >
              Delete overlay
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (selection.track === "sfx") {
    const clip = edl.sfx.find((s) => s.id === selection.id);
    if (!clip) return null;
    return (
      <div className="flex h-full flex-col">
        {header("Sound effect", clip.src.split("/").pop())}
        <div className="flex flex-col gap-4 overflow-y-auto p-4">
          <Field label={`Volume — ${Math.round(clip.volume * 100)}%`}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              defaultValue={clip.volume}
              onChange={(e) =>
                onOp({ type: "setProp", track: "sfx", id: clip.id, patch: { volume: Number(e.target.value) } })
              }
              className="w-full"
            />
          </Field>
          <div className="mt-2 border-t border-white/8 pt-4">
            <button
              onClick={() => onOp({ type: "delete", track: "sfx", id: clip.id })}
              className="rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-400 hover:bg-red-500/10"
            >
              Delete sound effect
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (selection.track === "transition") {
    const t = edl.transitions.find((t) => t.afterClipId === selection.id);
    if (!t) return null;
    return (
      <div className="flex h-full flex-col">
        {header("Transition", `at ${t.atSec.toFixed(2)}s`)}
        <div className="flex flex-col gap-4 p-4">
          <Field label="Style">
            <select
              value={t.component}
              onChange={(e) =>
                onOp({
                  type: "setProp",
                  track: "transition",
                  id: selection.id,
                  patch: { component: e.target.value },
                })
              }
              className={inputClass}
            >
              {TRANSITIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Duration — ${t.durationSec.toFixed(2)}s`}>
            <input
              type="range"
              min={0.05}
              max={1.5}
              step={0.05}
              defaultValue={t.durationSec}
              onChange={(e) =>
                onOp({
                  type: "setProp",
                  track: "transition",
                  id: selection.id,
                  patch: { durationSec: Number(e.target.value) },
                })
              }
              className="w-full"
            />
          </Field>
          <p className="text-xs text-[color:var(--ink-dim)]">
            Position isn't draggable — a transition always sits exactly at the cut between two clips,
            so it moves automatically when you trim or reorder the clip next to it.
          </p>
        </div>
      </div>
    );
  }

  if (selection.track === "music" && edl.music) {
    const durationSec = edl.music.durationSec ?? edl.durationSec - edl.music.tlInSec;
    return (
      <div className="flex h-full flex-col">
        {header("Music", edl.music.src.split("/").pop())}
        <div className="flex flex-col gap-4 overflow-y-auto p-4">
          <Field label="Timeline window">
            <p className="text-sm text-[color:var(--ink)]">
              {edl.music.tlInSec.toFixed(2)}s – {(edl.music.tlInSec + durationSec).toFixed(2)}s
              <span className="text-[color:var(--ink-dim)]"> ({durationSec.toFixed(2)}s)</span>
            </p>
          </Field>
          <Field label={`Volume — ${Math.round(edl.music.volume * 100)}%`}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              defaultValue={edl.music.volume}
              onChange={(e) =>
                onOp({ type: "setProp", track: "music", id: "music", patch: { volume: Number(e.target.value) } })
              }
              className="w-full"
            />
          </Field>
        </div>
      </div>
    );
  }

  if (selection.track === "captions") {
    const group = edl.captions.find((c) => c.id === selection.id);
    if (!group) return null;
    const canSplit = currentTimeSec > group.tlInSec + 0.1 && currentTimeSec < group.tlOutSec - 0.1;
    return (
      <div className="flex h-full flex-col">
        {header("Caption group", `${group.tlInSec.toFixed(2)}s – ${group.tlOutSec.toFixed(2)}s`)}
        <div className="flex flex-col gap-4 overflow-y-auto p-4">
          <Field label="Text (auto-transcribed, drag to retime)">
            <p className="text-sm text-[color:var(--ink)]">{group.words.map((w) => w.text).join(" ")}</p>
          </Field>
          <div className="mt-2 flex flex-col gap-2 border-t border-white/8 pt-4">
            <button
              disabled={!canSplit}
              onClick={() => onOp({ type: "split", track: "captions", id: group.id, atSec: currentTimeSec })}
              className="rounded-lg border border-white/12 px-3 py-2 text-sm text-[color:var(--ink)] hover:border-[color:var(--accent)]/50 disabled:opacity-30"
            >
              Split at playhead
            </button>
            <button
              onClick={() => onOp({ type: "delete", track: "captions", id: group.id })}
              className="rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-400 hover:bg-red-500/10"
            >
              Delete caption group
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

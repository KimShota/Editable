"use client";

import type { Edl } from "@backend/pipeline/types";
import type { TimelineOp } from "@backend/pipeline/timelineOps";
import { Selection } from "./selection";
import { CloseIcon, ScissorsIcon, TrashIcon } from "./Icons";

const TRANSITIONS = [
  { value: "cut", label: "Cut" },
  { value: "fade", label: "Fade" },
  { value: "whooshZoom", label: "Whoosh zoom" },
];

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-1.5">
    <label className="text-[11px] tracking-wide text-[color:var(--ed-ink-dim)] uppercase">{label}</label>
    {children}
  </div>
);

const inputClass =
  "w-full rounded-lg border border-[color:var(--ed-border-strong)] bg-[color:var(--ed-raised)] px-2.5 py-1.5 text-sm text-[color:var(--ed-ink)] outline-none focus:border-[color:var(--ed-accent)]";

const secondaryButtonClass =
  "flex items-center justify-center gap-2 rounded-lg border border-[color:var(--ed-border-strong)] px-3 py-2 text-sm text-[color:var(--ed-ink)] transition-colors hover:border-[color:var(--ed-accent)]/50 hover:bg-[color:var(--ed-raised)] disabled:pointer-events-none disabled:opacity-30";

const dangerButtonClass =
  "flex items-center justify-center gap-2 rounded-lg border border-[color:var(--ed-danger)]/30 px-3 py-2 text-sm text-[color:var(--ed-danger)] transition-colors hover:bg-[color:var(--ed-danger)]/10 disabled:pointer-events-none disabled:opacity-30";

const sectionClass = "flex flex-col gap-4 overflow-y-auto p-4";
const actionsClass = "mt-2 flex flex-col gap-2 border-t border-[color:var(--ed-border)] pt-4";

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
        <p className="text-sm text-[color:var(--ed-ink-dim)]">Select a clip on the timeline to edit it.</p>
      </div>
    );
  }

  const header = (title: string, subtitle?: string) => (
    <div className="flex items-center justify-between border-b border-[color:var(--ed-border)] p-4">
      <div className="min-w-0">
        <p className="truncate font-[family-name:var(--ed-font-display)] text-sm font-semibold text-[color:var(--ed-ink)]">
          {title}
        </p>
        {subtitle && <p className="truncate text-xs text-[color:var(--ed-ink-dim)]">{subtitle}</p>}
      </div>
      <button
        onClick={onDeselect}
        className="flex h-6 w-6 items-center justify-center rounded-md text-[color:var(--ed-ink-dim)] transition-colors hover:bg-[color:var(--ed-raised)] hover:text-[color:var(--ed-ink)]"
      >
        <CloseIcon className="h-3.5 w-3.5" />
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
        <div className={sectionClass}>
          <Field label="Timeline position">
            <p className="text-sm tabular-nums text-[color:var(--ed-ink)]">
              {clip.tlInSec.toFixed(2)}s – {clip.tlOutSec.toFixed(2)}s
              <span className="text-[color:var(--ed-ink-dim)]"> ({(clip.tlOutSec - clip.tlInSec).toFixed(2)}s)</span>
            </p>
          </Field>
          <Field label="Source range">
            <p className="text-sm tabular-nums text-[color:var(--ed-ink)]">
              {clip.srcInSec.toFixed(2)}s – {clip.srcOutSec.toFixed(2)}s
              {clip.srcDurationSec !== undefined && (
                <span className="text-[color:var(--ed-ink-dim)]"> of {clip.srcDurationSec.toFixed(2)}s source</span>
              )}
            </p>
          </Field>
          <label className="flex items-center gap-2 text-sm text-[color:var(--ed-ink)]">
            <input
              type="checkbox"
              checked={clip.muted}
              onChange={(e) =>
                onOp({ type: "setProp", track: "video", id: clip.id, patch: { muted: e.target.checked } })
              }
              className="accent-[color:var(--ed-accent)]"
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

          <div className={actionsClass}>
            <button
              disabled={!canSplit}
              onClick={() => onOp({ type: "split", track: "video", id: clip.id, atSec: currentTimeSec })}
              className={secondaryButtonClass}
            >
              <ScissorsIcon className="h-4 w-4" />
              Split at playhead
            </button>
            <button
              disabled={edl.video.length <= 1}
              onClick={() => onOp({ type: "delete", track: "video", id: clip.id })}
              className={dangerButtonClass}
            >
              <TrashIcon className="h-4 w-4" />
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
        <div className={sectionClass}>
          <Field label="Timeline position">
            <p className="text-sm tabular-nums text-[color:var(--ed-ink)]">
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
          <div className={actionsClass}>
            <button
              disabled={!canSplit}
              onClick={() => onOp({ type: "split", track: "overlay", id: clip.id, atSec: currentTimeSec })}
              className={secondaryButtonClass}
            >
              <ScissorsIcon className="h-4 w-4" />
              Split at playhead
            </button>
            <button onClick={() => onOp({ type: "delete", track: "overlay", id: clip.id })} className={dangerButtonClass}>
              <TrashIcon className="h-4 w-4" />
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
        <div className={sectionClass}>
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
              className="w-full accent-[color:var(--ed-accent)]"
            />
          </Field>
          <div className={actionsClass}>
            <button onClick={() => onOp({ type: "delete", track: "sfx", id: clip.id })} className={dangerButtonClass}>
              <TrashIcon className="h-4 w-4" />
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
        <div className={sectionClass}>
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
              className="w-full accent-[color:var(--ed-accent)]"
            />
          </Field>
          <p className="text-xs text-[color:var(--ed-ink-dim)]">
            Drag the transition on the timeline to snap it onto a different cut, or drag its right edge to
            change how long it plays. It also moves automatically when you trim or reorder the clip next to it.
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
        <div className={sectionClass}>
          <Field label="Timeline window">
            <p className="text-sm tabular-nums text-[color:var(--ed-ink)]">
              {edl.music.tlInSec.toFixed(2)}s – {(edl.music.tlInSec + durationSec).toFixed(2)}s
              <span className="text-[color:var(--ed-ink-dim)]"> ({durationSec.toFixed(2)}s)</span>
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
              className="w-full accent-[color:var(--ed-accent)]"
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
        <div className={sectionClass}>
          <Field label="Text (auto-transcribed, drag to retime)">
            <p className="text-sm text-[color:var(--ed-ink)]">{group.words.map((w) => w.text).join(" ")}</p>
          </Field>
          <div className={actionsClass}>
            <button
              disabled={!canSplit}
              onClick={() => onOp({ type: "split", track: "captions", id: group.id, atSec: currentTimeSec })}
              className={secondaryButtonClass}
            >
              <ScissorsIcon className="h-4 w-4" />
              Split at playhead
            </button>
            <button
              onClick={() => onOp({ type: "delete", track: "captions", id: group.id })}
              className={dangerButtonClass}
            >
              <TrashIcon className="h-4 w-4" />
              Delete caption group
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

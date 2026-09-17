"use client";

import { useRef, useState } from "react";
import type { Slot } from "@backend/pipeline/types";
import { tierColor } from "@backend/remotion/components/tiers";
import { LIBRARY_DRAG_MIME, type LibraryDragPayload } from "../../../../lib/dnd";
import { LineKind, Pill } from "../../../../_components/ui";
import { slotLabel } from "../../../../lib/slotLabel";

export type Binding = { file: string } | { files: string[] } | { text: string };

const mediaUrl = (jobId: string, file: string) => `/api/media/jobs/${jobId}/${file}`;
/** A format's own checked-in default asset (see SlotSchema's defaultAsset)
 *  — served from formats/assets/<formatId>/, not a job's own assets/. */
const formatAssetUrl = (formatId: string, file: string) => `/api/media/formats/assets/${formatId}/${file}`;

/** Binds one or more files at once — a multi-take slot APPENDS to whatever
 *  is already bound; a single-file slot replaces it (see the API route). */
async function bindFiles(jobId: string, slotName: string, files: File[]): Promise<Binding> {
  const body = new FormData();
  body.set("slot", slotName);
  for (const file of files) body.append("file", file);
  const res = await fetch(`/api/jobs/${jobId}/assets`, { method: "POST", body });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "upload failed");
  return data.binding;
}

async function bindLibraryRef(jobId: string, slotName: string, ref: LibraryDragPayload): Promise<Binding> {
  const body = new FormData();
  body.set("slot", slotName);
  body.set("libraryRef", JSON.stringify({ category: ref.category, filename: ref.filename }));
  const res = await fetch(`/api/jobs/${jobId}/assets`, { method: "POST", body });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "bind failed");
  return data.binding;
}

async function bindFormatDefault(jobId: string, slotName: string): Promise<Binding> {
  const body = new FormData();
  body.set("slot", slotName);
  body.set("formatDefault", "1");
  const res = await fetch(`/api/jobs/${jobId}/assets`, { method: "POST", body });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "bind failed");
  return data.binding;
}

export async function bindText(jobId: string, slotName: string, text: string): Promise<Binding> {
  const body = new FormData();
  body.set("slot", slotName);
  body.set("text", text);
  const res = await fetch(`/api/jobs/${jobId}/assets`, { method: "POST", body });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "save failed");
  return data.binding;
}

/** Omit `index` to clear the whole slot; pass it to drop just one take. */
async function clearSlot(jobId: string, slotName: string, index?: number): Promise<Binding | undefined> {
  const qs = index !== undefined ? `?index=${index}` : "";
  const res = await fetch(`/api/jobs/${jobId}/assets/${slotName}${qs}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  return data.binding;
}

/** A control slot's own option list — authored directly on `slot.control`,
 *  or (optionsFromSlot) pulled from a sibling text slot's own CURRENT
 *  binding, comma-split — e.g. category-tier-list-reveal's per-item
 *  "choice" tier pickers reading its "orderedChoice" tierOrder slot, so
 *  each one always offers exactly the tiers the user picked, in the order
 *  they put them in. Options resolved this way carry no authored
 *  label/color (the sibling binding is just plain text) — chip color
 *  falls back to tiers.ts's tierColor() in that case. */
function resolveControlOptions(
  slot: Slot,
  siblingBindings: Record<string, Binding | undefined>,
): Array<{ value: string; label?: string; color?: string }> {
  const control = slot.control;
  if (!control) return [];
  if (control.options) return control.options;
  if (control.optionsFromSlot) {
    const source = siblingBindings[control.optionsFromSlot];
    const raw = source && "text" in source ? source.text : "";
    return raw
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .map((value) => ({ value }));
  }
  return [];
}

export function SlotDropzone({
  jobId,
  formatId,
  slot,
  binding,
  siblingBindings,
  onChange,
  multi = false,
  coveredNote,
  onDraftChange,
}: {
  jobId: string;
  /** Needed only to preview/bind slot.defaultAsset, which lives under
   *  formats/assets/<formatId>/ — omit for a call site whose slots never
   *  declare one (harmless either way, the choice just won't render). */
  formatId?: string;
  slot: Slot;
  binding?: Binding;
  /** The whole job's binding map — needed only by a `slot.control` with
   *  `optionsFromSlot` (see resolveControlOptions above), which has to read
   *  ANOTHER slot's current value, not just its own. Omit for a call site
   *  whose slots never declare a control (harmless either way). */
  siblingBindings?: Record<string, Binding | undefined>;
  onChange: (slotName: string, binding: Binding | undefined) => void;
  /** A voice block's main clip may be filmed as several separate takes
   *  (e.g. the marker line and the explanation shot apart) — dropping more
   *  than one here appends takes instead of replacing the binding; they're
   *  auto-ordered and stitched together once the video is built. */
  multi?: boolean;
  /** Set when a bound speaking take currently covers this slot (see
   *  ResourcesBoard.tsx's takeCoveredSlots) — shown as an explanatory note
   *  instead of hiding the dropzone outright, so dropping a clip here still
   *  works to re-film just this one line on its own. */
  coveredNote?: string;
  /** Text slots only: fires on every keystroke (not just blur) so a caller
   *  can mirror the in-progress value into a live preview — the textarea
   *  itself stays uncontrolled (defaultValue) and still only PERSISTS on
   *  blur, this is purely a read-side tap. */
  onDraftChange?: (slotName: string, value: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  if (slot.mediaType === "text" && slot.control) {
    const control = slot.control;
    const options = resolveControlOptions(slot, siblingBindings ?? {});
    const currentText = binding && "text" in binding ? binding.text : "";

    const persist = async (nextValue: string) => {
      setBusy(true);
      setError(null);
      try {
        onChange(slot.name, nextValue ? await bindText(jobId, slot.name, nextValue) : await clearSlot(jobId, slot.name));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    };

    const chipClass = (selected: boolean) =>
      `rounded-full px-3 py-1 text-xs font-bold text-black transition-opacity disabled:cursor-not-allowed ${
        selected ? "" : "opacity-40 hover:opacity-70"
      }`;

    if (control.kind === "choice") {
      return (
        <SlotShell slot={slot} filled={!!currentText}>
          <div className="flex flex-wrap gap-2">
            {options.map((opt) => {
              const selected = currentText === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  disabled={busy}
                  onClick={() => persist(selected ? "" : opt.value)}
                  className={chipClass(selected)}
                  style={{ backgroundColor: opt.color ?? tierColor(opt.value) }}
                >
                  {opt.label ?? opt.value}
                </button>
              );
            })}
          </div>
          {options.length === 0 && (
            <p className="text-[12px] text-[color:var(--ink-dim)]">
              {control.optionsFromSlot ? `Fill in "${control.optionsFromSlot}" first.` : "No options."}
            </p>
          )}
          {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
        </SlotShell>
      );
    }

    // orderedChoice: the full option universe up top (click to toggle
    // inclusion), the currently-chosen subset below it as a reorderable
    // list — one text binding, "value, value, …" in the order shown.
    const chosen = currentText
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    const toggle = (value: string) => {
      const next = chosen.includes(value) ? chosen.filter((v) => v !== value) : [...chosen, value];
      persist(next.join(", "));
    };
    const move = (index: number, dir: -1 | 1) => {
      const next = [...chosen];
      const target = index + dir;
      if (target < 0 || target >= next.length) return;
      [next[index], next[target]] = [next[target], next[index]];
      persist(next.join(", "));
    };

    return (
      <SlotShell slot={slot} filled={chosen.length > 0}>
        <div className="flex flex-wrap gap-2">
          {options.map((opt) => {
            const selected = chosen.includes(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                disabled={busy}
                onClick={() => toggle(opt.value)}
                className={chipClass(selected)}
                style={{ backgroundColor: opt.color ?? tierColor(opt.value) }}
              >
                {opt.label ?? opt.value}
              </button>
            );
          })}
        </div>
        {chosen.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            {chosen.map((value, i) => {
              const opt = options.find((o) => o.value === value);
              return (
                <div
                  key={value}
                  className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-2 py-1"
                >
                  <span
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: opt?.color ?? tierColor(value) }}
                  />
                  <span className="flex-1 text-sm text-[color:var(--ink)]">{opt?.label ?? value}</span>
                  <button
                    type="button"
                    disabled={busy || i === 0}
                    onClick={() => move(i, -1)}
                    className="text-xs text-[color:var(--ink-dim)] hover:text-[color:var(--ink)] disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={busy || i === chosen.length - 1}
                    onClick={() => move(i, 1)}
                    className="text-xs text-[color:var(--ink-dim)] hover:text-[color:var(--ink)] disabled:opacity-30"
                  >
                    ↓
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      </SlotShell>
    );
  }

  if (slot.mediaType === "text") {
    const hasText = !!binding && "text" in binding && binding.text.trim().length > 0;
    return (
      <SlotShell slot={slot} kind="onscreen" filled={hasText}>
        <textarea
          defaultValue={binding && "text" in binding ? binding.text : ""}
          placeholder={slot.example ? `e.g. ${slot.example}` : undefined}
          onChange={(e) => onDraftChange?.(slot.name, e.target.value)}
          onBlur={async (e) => {
            const value = e.target.value;
            const hadBinding = binding && "text" in binding;
            setError(null);
            // Blurring back to empty clears a previously-saved value instead
            // of silently leaving the stale text bound — an empty field
            // that was never filled needs no network round-trip at all.
            if (!value.trim()) {
              if (!hadBinding) return;
              setBusy(true);
              try {
                onChange(slot.name, await clearSlot(jobId, slot.name));
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
              return;
            }
            setBusy(true);
            try {
              onChange(slot.name, await bindText(jobId, slot.name, value));
              setSavedFlash(true);
              setTimeout(() => setSavedFlash(false), 1500);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
          rows={3}
          className="w-full resize-none rounded-lg border border-white/12 bg-black/20 p-3 text-sm text-[color:var(--ink)] outline-none placeholder:text-[color:var(--ink-dim)] focus:border-[color:var(--accent)]"
        />
        {slot.example && (
          <p className="mt-1 text-[11px] text-[color:var(--ink-dim)]">Example: {slot.example}</p>
        )}
        {busy && <p className="mt-1 text-xs text-[color:var(--ink-dim)]">Saving…</p>}
        {savedFlash && !busy && <p className="mt-1 text-xs text-emerald-400">Saved</p>}
        {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      </SlotShell>
    );
  }

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      onChange(slot.name, await bindFiles(jobId, slot.name, multi ? files : [files[0]]));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const libraryPayload = e.dataTransfer.getData(LIBRARY_DRAG_MIME);
    if (libraryPayload) {
      setBusy(true);
      setError(null);
      try {
        const ref = JSON.parse(libraryPayload) as LibraryDragPayload;
        onChange(slot.name, await bindLibraryRef(jobId, slot.name, ref));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    handleFiles(Array.from(e.dataTransfer.files ?? []));
  };

  const useDefault = async () => {
    setBusy(true);
    setError(null);
    try {
      onChange(slot.name, await bindFormatDefault(jobId, slot.name));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clear = async (index?: number) => {
    if (index !== undefined) {
      const next = await clearSlot(jobId, slot.name, index);
      onChange(slot.name, next);
      return;
    }
    onChange(slot.name, undefined);
    await clearSlot(jobId, slot.name);
  };

  // A slot that used to bind exactly one file (the speaking-take slot,
  // before it accepted several clips) may still carry an old {file}
  // binding — shown here as a one-item list so it doesn't just vanish from
  // a now-multi dropzone.
  const takeFiles = binding && "files" in binding ? binding.files : binding && "file" in binding ? [binding.file] : undefined;

  if (multi) {
    return (
      <SlotShell slot={slot} coveredNote={coveredNote} filled={!!takeFiles?.length}>
        <input
          ref={fileInput}
          type="file"
          accept={`${slot.mediaType}/*`}
          multiple
          className="hidden"
          onChange={(e) => handleFiles(Array.from(e.target.files ?? []))}
        />
        <div className="flex flex-col gap-2">
          {(takeFiles ?? []).map((file, i) => (
            <div key={file} className="relative min-h-[80px] overflow-hidden rounded-lg border border-white/10 bg-black/30">
              <div className="absolute top-2 left-2 z-10 rounded-full bg-black/70 px-2 py-0.5 text-[11px] text-white">
                {slot.mediaType === "image" ? `Photo ${i + 1}` : `Take ${i + 1}`}
              </div>
              <SlotPreview jobId={jobId} slot={slot} file={file} />
              <button
                onClick={() => clear(i)}
                className="absolute top-2 right-2 rounded-full bg-black/70 px-2.5 py-1 text-[11px] text-white hover:bg-black/90"
              >
                Remove
              </button>
            </div>
          ))}
          <div
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={`flex min-h-[80px] cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-4 text-center transition-colors ${
              dragOver ? "border-[color:var(--accent)] bg-[color:var(--accent)]/5" : "border-white/15 hover:border-white/30"
            }`}
          >
            <p className="text-xs text-[color:var(--ink-dim)]">
              {busy
                ? "Uploading…"
                : slot.mediaType === "image"
                  ? takeFiles?.length
                    ? "Drop another photo, or click"
                    : "Drop 1 or more clear reference photos, or click"
                  : takeFiles?.length
                    ? "Drop another take, or click"
                    : "Drop 1 or more clips, drag from Library, or click"}
            </p>
          </div>
        </div>
        {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      </SlotShell>
    );
  }

  const boundFile = binding && "file" in binding ? binding.file : undefined;

  return (
    <SlotShell slot={slot} coveredNote={coveredNote} filled={!!boundFile}>
      <input
        ref={fileInput}
        type="file"
        accept={`${slot.mediaType}/*`}
        className="hidden"
        onChange={(e) => e.target.files?.[0] && handleFiles([e.target.files[0]])}
      />
      {boundFile ? (
        <div className="relative min-h-[110px] overflow-hidden rounded-lg border border-white/10 bg-black/30">
          <SlotPreview jobId={jobId} slot={slot} file={boundFile} />
          <div className="absolute top-2 right-2 flex gap-1.5">
            <button
              onClick={() => fileInput.current?.click()}
              className="rounded-full bg-black/70 px-2.5 py-1 text-[11px] text-white hover:bg-black/90"
            >
              Replace
            </button>
            <button
              onClick={() => clear()}
              className="rounded-full bg-black/70 px-2.5 py-1 text-[11px] text-white hover:bg-black/90"
            >
              Clear
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={`flex min-h-[110px] cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-4 text-center transition-colors ${
              dragOver ? "border-[color:var(--accent)] bg-[color:var(--accent)]/5" : "border-white/15 hover:border-white/30"
            }`}
          >
            <p className="text-xs text-[color:var(--ink-dim)]">
              {busy ? "Uploading…" : "Drop a file, drag from Library, or click"}
            </p>
          </div>
          {formatId && slot.defaultAsset && (
            <DefaultAssetOption
              formatId={formatId}
              slot={slot}
              defaultAsset={slot.defaultAsset}
              busy={busy}
              onUse={useDefault}
            />
          )}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </SlotShell>
  );
}

/** The "or use our template clip" alternative to filming your own — shown
 *  only while the slot is unbound (once filled, Replace/Clear cover the
 *  same ground, whichever source it came from). */
function DefaultAssetOption({
  formatId,
  slot,
  defaultAsset,
  busy,
  onUse,
}: {
  formatId: string;
  slot: Slot;
  defaultAsset: NonNullable<Slot["defaultAsset"]>;
  busy: boolean;
  onUse: () => void;
}) {
  const [preview, setPreview] = useState(false);
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-[color:var(--ink-dim)]">
          Don&apos;t want to film this? {defaultAsset.label ?? "Use our template clip"} instead.
        </p>
        <div className="flex shrink-0 gap-1.5">
          <button
            onClick={() => setPreview((p) => !p)}
            className="rounded-full border border-white/15 px-2.5 py-1 text-[11px] text-[color:var(--ink)] hover:border-white/30"
          >
            {preview ? "Hide" : "Preview"}
          </button>
          <button
            onClick={onUse}
            disabled={busy}
            className="rounded-full bg-[color:var(--accent)] px-2.5 py-1 text-[11px] font-medium text-black disabled:opacity-50"
          >
            {busy ? "Using…" : "Use this clip"}
          </button>
        </div>
      </div>
      {preview && (
        <div className="mt-2 overflow-hidden rounded-lg border border-white/10 bg-black/30">
          {slot.mediaType === "video" ? (
            <video src={formatAssetUrl(formatId, defaultAsset.file)} controls muted className="max-h-[220px] w-full object-contain" />
          ) : slot.mediaType === "image" ? (
            <img src={formatAssetUrl(formatId, defaultAsset.file)} alt="" className="max-h-[220px] w-full object-contain" />
          ) : (
            <audio src={formatAssetUrl(formatId, defaultAsset.file)} controls className="w-full p-3" />
          )}
        </div>
      )}
    </div>
  );
}

function SlotShell({
  slot,
  coveredNote,
  kind,
  filled,
  children,
}: {
  slot: Slot;
  coveredNote?: string;
  /** Set only for a text slot — badges it as on-screen text so it isn't
   *  mistaken for a spoken line (see ScriptLines.tsx for that counterpart). */
  kind?: "onscreen";
  /** Whether this slot currently has a saved binding — shown as a quiet
   *  "Saved" checkmark so it's obvious at a glance which fields still need
   *  attention, instead of making the user reopen every field to check. */
  filled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium text-[color:var(--ink)]">{slotLabel(slot)}</p>
        {!slot.required && <Pill>Optional</Pill>}
        {kind === "onscreen" && <LineKind kind="onscreen" />}
        {filled && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" className="shrink-0">
              <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Saved
          </span>
        )}
      </div>
      <p className="text-[12px] leading-snug text-[color:var(--ink-dim)]">{slot.instructions}</p>
      {coveredNote && (
        <p className="rounded-md border border-dashed border-[color:var(--accent)]/30 bg-[color:var(--accent)]/5 px-2 py-1 text-[11px] leading-snug text-[color:var(--accent)]">
          {coveredNote}
        </p>
      )}
      {children}
    </div>
  );
}

/** A bound file that can't actually be decoded/rendered as its slot's media
 *  type (wrong format, corrupted upload, a mismatch the intake pipeline
 *  hasn't caught yet) used to leave the <img>/<video>/<audio> tag broken or
 *  collapsed to near-zero height — which pushed the Replace/Clear buttons
 *  (absolutely positioned over this preview) out of view too, so a file
 *  that couldn't be previewed effectively couldn't be removed either. This
 *  always renders SOMETHING with real height, so those buttons stay put and
 *  clickable no matter what the file turns out to be. */
function SlotPreview({ jobId, slot, file }: { jobId: string; slot: Slot; file: string }) {
  const [failed, setFailed] = useState(false);
  const src = mediaUrl(jobId, file);
  const onError = () => setFailed(true);

  if (failed) {
    return (
      <div className="flex min-h-[110px] flex-col items-center justify-center gap-1 p-4 text-center">
        <p className="text-xs text-[color:var(--ink-dim)]">
          Couldn&apos;t preview this file — use Replace or Clear below.
        </p>
      </div>
    );
  }
  if (slot.mediaType === "video") {
    return <video src={src} controls muted onError={onError} className="max-h-[220px] w-full object-contain" />;
  }
  if (slot.mediaType === "image") {
    return <img src={src} alt="" onError={onError} className="max-h-[220px] w-full object-contain" />;
  }
  return (
    <audio src={src} controls onError={onError} className="w-full p-3">
      Your browser does not support audio playback.
    </audio>
  );
}

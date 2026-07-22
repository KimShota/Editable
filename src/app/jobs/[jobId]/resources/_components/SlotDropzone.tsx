"use client";

import { useRef, useState } from "react";
import type { Slot } from "@backend/pipeline/types";
import { LIBRARY_DRAG_MIME, type LibraryDragPayload } from "../../../../lib/dnd";

export type Binding = { file: string } | { files: string[] } | { text: string };

const mediaUrl = (jobId: string, file: string) => `/api/media/jobs/${jobId}/${file}`;

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

async function bindText(jobId: string, slotName: string, text: string): Promise<Binding> {
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

export function SlotDropzone({
  jobId,
  slot,
  binding,
  onChange,
  multi = false,
}: {
  jobId: string;
  slot: Slot;
  binding?: Binding;
  onChange: (slotName: string, binding: Binding | undefined) => void;
  /** A voice block's main clip may be filmed as several separate takes
   *  (e.g. the marker line and the explanation shot apart) — dropping more
   *  than one here appends takes instead of replacing the binding; they're
   *  auto-ordered and stitched together once the video is built. */
  multi?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  if (slot.mediaType === "text") {
    return (
      <SlotShell slot={slot}>
        <textarea
          defaultValue={binding && "text" in binding ? binding.text : ""}
          placeholder={slot.instructions}
          onBlur={async (e) => {
            const value = e.target.value;
            if (!value.trim()) return;
            setBusy(true);
            try {
              onChange(slot.name, await bindText(jobId, slot.name, value));
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
          rows={3}
          className="w-full resize-none rounded-lg border border-white/12 bg-black/20 p-3 text-sm text-[color:var(--ink)] outline-none focus:border-[color:var(--accent)]"
        />
        {busy && <p className="mt-1 text-xs text-[color:var(--ink-dim)]">Saving…</p>}
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

  const clear = async (index?: number) => {
    if (index !== undefined) {
      const next = await clearSlot(jobId, slot.name, index);
      onChange(slot.name, next);
      return;
    }
    onChange(slot.name, undefined);
    await clearSlot(jobId, slot.name);
  };

  const takeFiles = binding && "files" in binding ? binding.files : undefined;

  if (multi) {
    return (
      <SlotShell slot={slot}>
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
            <div key={file} className="relative overflow-hidden rounded-lg border border-white/10 bg-black/30">
              <div className="absolute top-2 left-2 z-10 rounded-full bg-black/70 px-2 py-0.5 text-[11px] text-white">
                Take {i + 1}
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
                : takeFiles?.length
                  ? "Drop another take, or click"
                  : "Drop 1 or more takes, drag from Library, or click — filmed the marker line and the explanation separately? Drop both, they'll be auto-ordered and stitched together"}
            </p>
          </div>
        </div>
        {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      </SlotShell>
    );
  }

  const boundFile = binding && "file" in binding ? binding.file : undefined;

  return (
    <SlotShell slot={slot}>
      <input
        ref={fileInput}
        type="file"
        accept={`${slot.mediaType}/*`}
        className="hidden"
        onChange={(e) => e.target.files?.[0] && handleFiles([e.target.files[0]])}
      />
      {boundFile ? (
        <div className="relative overflow-hidden rounded-lg border border-white/10 bg-black/30">
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
      )}
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </SlotShell>
  );
}

function SlotShell({ slot, children }: { slot: Slot; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${slot.required ? "bg-[color:var(--accent)]" : "bg-white/20"}`} />
        <p className="text-sm font-medium text-[color:var(--ink)]">{slot.name}</p>
        <span className="text-[11px] text-[color:var(--ink-dim)]">
          {slot.mediaType}
          {!slot.required && ", optional"}
        </span>
      </div>
      <p className="text-[12px] leading-snug text-[color:var(--ink-dim)]">{slot.instructions}</p>
      {children}
    </div>
  );
}

function SlotPreview({ jobId, slot, file }: { jobId: string; slot: Slot; file: string }) {
  const src = mediaUrl(jobId, file);
  if (slot.mediaType === "video") {
    return <video src={src} controls muted className="max-h-[220px] w-full object-contain" />;
  }
  if (slot.mediaType === "image") {
    return <img src={src} alt="" className="max-h-[220px] w-full object-contain" />;
  }
  return (
    <audio src={src} controls className="w-full p-3">
      Your browser does not support audio playback.
    </audio>
  );
}

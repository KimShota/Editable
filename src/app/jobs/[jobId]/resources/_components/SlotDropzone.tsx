"use client";

import { useRef, useState } from "react";
import type { Slot } from "../../../../../pipeline/types";
import { LIBRARY_DRAG_MIME, type LibraryDragPayload } from "../../../../lib/dnd";

export type Binding = { file: string } | { text: string };

const mediaUrl = (jobId: string, file: string) => `/api/media/jobs/${jobId}/${file}`;

async function bindFile(jobId: string, slotName: string, file: File): Promise<Binding> {
  const body = new FormData();
  body.set("slot", slotName);
  body.set("file", file);
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

async function clearSlot(jobId: string, slotName: string): Promise<void> {
  await fetch(`/api/jobs/${jobId}/assets/${slotName}`, { method: "DELETE" });
}

export function SlotDropzone({
  jobId,
  slot,
  binding,
  onChange,
}: {
  jobId: string;
  slot: Slot;
  binding?: Binding;
  onChange: (slotName: string, binding: Binding | undefined) => void;
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

  const handleFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      onChange(slot.name, await bindFile(jobId, slot.name, file));
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
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const clear = async () => {
    onChange(slot.name, undefined);
    await clearSlot(jobId, slot.name);
  };

  const boundFile = binding && "file" in binding ? binding.file : undefined;

  return (
    <SlotShell slot={slot}>
      <input
        ref={fileInput}
        type="file"
        accept={`${slot.mediaType}/*`}
        className="hidden"
        onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
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
              onClick={clear}
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

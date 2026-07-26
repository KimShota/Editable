"use client";

import { useRef, useState } from "react";
import type { Slot } from "@backend/pipeline/types";
import { Card, Pill } from "../../../../_components/ui";
import { Binding } from "./SlotDropzone";

const POSITION_LABELS = ["Front", "Side", "Close-up"];
const MAX_EXTRA = 6;

const mediaUrl = (jobId: string, file: string) => `/api/media/jobs/${jobId}/${file}`;

async function uploadPhoto(jobId: string, slotName: string, file: File): Promise<Binding> {
  const body = new FormData();
  body.set("slot", slotName);
  body.append("file", file);
  const res = await fetch(`/api/jobs/${jobId}/assets`, { method: "POST", body });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "upload failed");
  return data.binding;
}

async function removePhoto(jobId: string, slotName: string, index: number): Promise<Binding | undefined> {
  const res = await fetch(`/api/jobs/${jobId}/assets/${slotName}?index=${index}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  return data.binding;
}

/**
 * Front/Side/Close-up labeled reference-photo grid for the identity slot,
 * plus an "extra angles" add box beyond the first 3 — same underlying
 * multi-file binding as a generic dropzone, just with per-position labels
 * for filming guidance (matching the reference-photo treatment in the
 * competitor wizard this was modeled on).
 *
 * Labels are POSITIONAL, not sticky per-photo: removing "Front" shifts
 * every later photo up one slot (the same reindexing the takes dropzone
 * elsewhere already does), so what was "Side" becomes the new "Front".
 * Fine for filling 3(+) photos in order; less clean if you remove/replace
 * mid-set, same trade-off the app already accepts for multi-take clips.
 */
export function IdentityPhotoGrid({
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
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputs = useRef<Record<number, HTMLInputElement | null>>({});

  const files = binding && "files" in binding ? binding.files : [];
  const extrasCount = Math.max(0, files.length - POSITION_LABELS.length);
  const showAddExtra = extrasCount < MAX_EXTRA;
  const totalBoxes = POSITION_LABELS.length + extrasCount + (showAddExtra ? 1 : 0);

  const handleUpload = async (index: number, file: File) => {
    setBusyIndex(index);
    setError(null);
    try {
      onChange(slot.name, await uploadPhoto(jobId, slot.name, file));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyIndex(null);
    }
  };

  const handleRemove = async (index: number) => {
    setBusyIndex(index);
    setError(null);
    try {
      onChange(slot.name, await removePhoto(jobId, slot.name, index));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyIndex(null);
    }
  };

  return (
    <Card className="p-6">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--ink)]">
          Identity photos
        </h2>
        <Pill>used for auto-generated shots</Pill>
      </div>
      <p className="mb-5 text-sm text-[color:var(--ink-dim)]">{slot.instructions}</p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {Array.from({ length: totalBoxes }, (_, index) => {
          const file = files[index];
          const label = POSITION_LABELS[index] ?? `Extra ${index - POSITION_LABELS.length + 1}`;
          return (
            <div key={index} className="flex flex-col gap-2">
              <input
                ref={(el) => {
                  fileInputs.current[index] = el;
                }}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && handleUpload(index, e.target.files[0])}
              />
              <div
                onClick={() => fileInputs.current[index]?.click()}
                className={`relative flex aspect-[3/4] cursor-pointer flex-col items-center justify-center overflow-hidden rounded-xl border transition-colors ${
                  file
                    ? "border-white/10 bg-black/30"
                    : "border-dashed border-white/15 hover:border-[color:var(--accent)]/50"
                }`}
              >
                {file ? (
                  <>
                    <img src={mediaUrl(jobId, file)} alt={label} className="h-full w-full object-cover" />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemove(index);
                      }}
                      className="absolute top-2 right-2 rounded-full bg-black/70 px-2 py-0.5 text-[11px] text-white hover:bg-black/90"
                    >
                      Remove
                    </button>
                  </>
                ) : (
                  <span className="text-2xl text-white/20">{busyIndex === index ? "…" : "+"}</span>
                )}
              </div>
              <p className="text-center text-xs text-[color:var(--ink-dim)]">
                {file || index < POSITION_LABELS.length ? label : "Add"}
              </p>
            </div>
          );
        })}
      </div>
      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
    </Card>
  );
}

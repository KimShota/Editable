"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Format, Slot } from "../../../../../pipeline/types";
import { Button, Card, Pill } from "../../../../_components/ui";
import { LibraryPanel } from "../../../../_components/library/LibraryPanel";
import { Binding, SlotDropzone } from "./SlotDropzone";

/** Every slot the format declares: block slots, shared slots, and music — same shape allSlots() computes server-side. */
const allSlots = (format: Format): Slot[] => [
  ...format.blocks.flatMap((b) => b.slots),
  ...format.sharedSlots,
  ...(format.musicSlot ? [format.musicSlot] : []),
];

export function ResourcesBoard({
  jobId,
  format,
  initialBindings,
}: {
  jobId: string;
  format: Format;
  initialBindings: Record<string, Binding>;
}) {
  const router = useRouter();
  const [bindings, setBindings] = useState<Record<string, Binding | undefined>>(initialBindings);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  const requiredSlots = useMemo(() => allSlots(format).filter((s) => s.required), [format]);
  const filledCount = requiredSlots.filter((s) => bindings[s.name]).length;
  const ready = filledCount === requiredSlots.length;

  const setBinding = (slotName: string, binding: Binding | undefined) => {
    setBindings((prev) => ({ ...prev, [slotName]: binding }));
  };

  const continueToEditor = async () => {
    setBuilding(true);
    setBuildError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "build failed");
      router.push(`/jobs/${jobId}/edit`);
    } catch (err) {
      setBuildError((err as Error).message);
      setBuilding(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-8 xl:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-6">
        {format.blocks.map((block) => (
          <Card key={block.id} className="p-6">
            <div className="mb-4 flex items-center gap-2">
              <h2 className="font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--ink)]">
                {block.title}
              </h2>
              <Pill>{block.kind === "voice" ? "spoken" : "b-roll"}</Pill>
            </div>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              {block.slots.map((slot) => (
                <SlotDropzone
                  key={slot.name}
                  jobId={jobId}
                  slot={slot}
                  binding={bindings[slot.name]}
                  onChange={setBinding}
                />
              ))}
            </div>
          </Card>
        ))}

        {format.sharedSlots.length > 0 && (
          <Card className="p-6">
            <div className="mb-4 flex items-center gap-2">
              <h2 className="font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--ink)]">
                Shared sounds
              </h2>
              <Pill>used across blocks</Pill>
            </div>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {format.sharedSlots.map((slot) => (
                <SlotDropzone
                  key={slot.name}
                  jobId={jobId}
                  slot={slot}
                  binding={bindings[slot.name]}
                  onChange={setBinding}
                />
              ))}
            </div>
          </Card>
        )}

        {format.musicSlot && (
          <Card className="p-6">
            <h2 className="mb-4 font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--ink)]">
              Music
            </h2>
            <div className="max-w-sm">
              <SlotDropzone
                jobId={jobId}
                slot={format.musicSlot}
                binding={bindings[format.musicSlot.name]}
                onChange={setBinding}
              />
            </div>
          </Card>
        )}

        <div className="sticky bottom-6 z-10 flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-[color:var(--bg)]/90 p-5 backdrop-blur-md">
          <div>
            <p className="text-sm text-[color:var(--ink)]">
              {filledCount} / {requiredSlots.length} required slots filled
            </p>
            {buildError && <p className="text-xs text-red-400">{buildError}</p>}
          </div>
          <Button onClick={continueToEditor} disabled={!ready || building}>
            {building ? "Building…" : "Continue to editor"}
          </Button>
        </div>
      </div>

      <div className={`xl:sticky xl:top-24 xl:h-[calc(100vh-140px)] ${drawerOpen ? "" : "xl:h-auto"}`}>
        <div className="mb-2 flex items-center justify-between xl:hidden">
          <p className="font-[family-name:var(--font-display)] text-sm text-[color:var(--ink-dim)]">Library</p>
          <button onClick={() => setDrawerOpen((v) => !v)} className="text-xs text-[color:var(--accent)]">
            {drawerOpen ? "Hide" : "Show"}
          </button>
        </div>
        {drawerOpen && (
          <div className="h-[520px] overflow-hidden rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] xl:h-full">
            <LibraryPanel variant="drawer" />
          </div>
        )}
      </div>
    </div>
  );
}

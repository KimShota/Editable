"use client";

import { useMemo, useState } from "react";
import { Player } from "@remotion/player";
import { EdlVideo } from "@backend/remotion/EdlVideo";
import type { Edl, Format } from "@backend/pipeline/types";
import { Card, Pill } from "../../../../_components/ui";
import { EventRow } from "./EventRow";
import { RenderPanel } from "./RenderPanel";

export function Editor({ jobId, format, initialEdl }: { jobId: string; format: Format; initialEdl: Edl }) {
  const [edl, setEdl] = useState<Edl>(initialEdl);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const blockStartMap = useMemo(
    () => Object.fromEntries(edl.video.map((v) => [v.blockId, v.tlInSec])),
    [edl.video],
  );

  const applyOverride = async (patch: { events?: object; transitions?: object }) => {
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "could not apply change");
      setEdl(data.edl);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const setEventTime = async (eventId: string, blockRelativeSec: number) => {
    setSavingId(eventId);
    await applyOverride({ events: { [eventId]: { timeSec: blockRelativeSec } } });
    setSavingId(null);
  };

  const setTransition = async (blockId: string, component: string) => {
    setSavingId(blockId);
    const params = component === "cut" ? {} : { durationSec: 0.3 };
    await applyOverride({ transitions: { [blockId]: { component, params } } });
    setSavingId(null);
  };

  return (
    <div className="grid grid-cols-1 gap-8 xl:grid-cols-[420px_1fr]">
      <div className="xl:sticky xl:top-24 xl:self-start">
        <div className="overflow-hidden rounded-2xl border border-[color:var(--card-border)] bg-black">
          <Player
            component={EdlVideo}
            inputProps={{ edl }}
            durationInFrames={Math.max(1, Math.round(edl.durationSec * edl.fps))}
            fps={edl.fps}
            compositionWidth={edl.width}
            compositionHeight={edl.height}
            style={{ width: "100%" }}
            controls
            loop
          />
        </div>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <div className="mt-5">
          <RenderPanel jobId={jobId} />
        </div>
      </div>

      <div className="flex flex-col gap-5">
        {format.blocks.map((block) => {
          const blockStart = blockStartMap[block.id] ?? 0;
          const events = block.events;
          if (events.length === 0 && !block.transitionAfter) return null;
          return (
            <Card key={block.id} className="p-6">
              <div className="mb-4 flex items-center gap-2">
                <h2 className="font-[family-name:var(--font-display)] text-lg font-bold text-[color:var(--ink)]">
                  {block.title}
                </h2>
                <Pill>{events.length} events</Pill>
              </div>
              <div className="flex flex-col divide-y divide-white/8">
                {events.map((event) => (
                  <EventRow
                    key={event.id}
                    event={event}
                    edl={edl}
                    blockStartSec={blockStart}
                    saving={savingId === event.id}
                    onSetTime={(sec) => setEventTime(event.id, sec)}
                  />
                ))}
              </div>
              {block.transitionAfter && (
                <div className="mt-4 flex items-center gap-3 border-t border-white/8 pt-4">
                  <p className="text-sm text-[color:var(--ink-dim)]">Transition after this block</p>
                  <select
                    defaultValue={
                      edl.transitions.find((t) => t.afterBlockId === block.id)?.component ??
                      block.transitionAfter.component
                    }
                    onChange={(e) => setTransition(block.id, e.target.value)}
                    disabled={savingId === block.id}
                    className="rounded-lg border border-white/12 bg-black/30 px-3 py-1.5 text-sm text-[color:var(--ink)] outline-none"
                  >
                    <option value="cut">Cut</option>
                    <option value="fade">Fade</option>
                    <option value="whooshZoom">Whoosh zoom</option>
                  </select>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

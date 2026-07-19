"use client";

import { useState } from "react";
import type { Edl, FormatEvent } from "../../../../../pipeline/types";
import { Pill } from "../../../../_components/ui";

/** Finds the resolved EDL entry (overlay or sfx) an authored event produced, if it wasn't skipped. */
const findEdlEntry = (edl: Edl, eventId: string) =>
  edl.overlays.find((o) => o.id === eventId) ?? edl.sfx.find((s) => s.id === eventId);

export function EventRow({
  event,
  edl,
  blockStartSec,
  saving,
  onSetTime,
}: {
  event: FormatEvent;
  edl: Edl;
  blockStartSec: number;
  saving: boolean;
  onSetTime: (blockRelativeSec: number) => void;
}) {
  const entry = findEdlEntry(edl, event.id);
  const currentSec = entry ? Math.max(0, entry.tlInSec - blockStartSec) : 0;
  const [value, setValue] = useState(currentSec.toFixed(2));

  if (!entry) {
    return (
      <div className="flex items-center justify-between gap-3 py-3">
        <div>
          <p className="text-sm text-[color:var(--ink)]">{event.id}</p>
          <p className="text-xs text-[color:var(--ink-dim)]">{event.component.component}</p>
        </div>
        <Pill>skipped — missing asset</Pill>
      </div>
    );
  }

  const componentName = "component" in entry ? entry.component : event.component.component;
  const duration = "tlOutSec" in entry ? entry.tlOutSec - entry.tlInSec : undefined;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm text-[color:var(--ink)]">{event.id}</p>
          <Pill>{event.kind}</Pill>
        </div>
        <p className="text-xs text-[color:var(--ink-dim)]">
          {componentName}
          {duration !== undefined ? ` · ${duration.toFixed(2)}s long` : ""}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs text-[color:var(--ink-dim)]">starts at</label>
        <input
          type="number"
          step={0.05}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            const parsed = Number(value);
            if (!Number.isNaN(parsed)) onSetTime(parsed);
          }}
          disabled={saving}
          className="w-20 rounded-lg border border-white/12 bg-black/30 px-2 py-1 text-right text-sm text-[color:var(--ink)] outline-none focus:border-[color:var(--accent)]"
        />
        <span className="text-xs text-[color:var(--ink-dim)]">s into block</span>
      </div>
    </div>
  );
}

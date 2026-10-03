"use client";

import { useEffect, useState } from "react";
import { PlusIcon, RegenerateIcon } from "./Icons";

/**
 * An AI video clip's takes, in the Inspector: every version of the shot ever
 * generated, the one on the timeline marked "In use". Clicking another take
 * puts it on the timeline (free, instant, undoable); "New take" generates
 * one more (see Editor's regenerateClip). Takes come from
 * /api/jobs/[jobId]/clip-takes; the list reloads whenever the clip's source
 * changes or a generation finishes.
 */

type TakeView = { id: string; src: string; inSec: number; createdAt: string; origin: "original" | "regenerated" | "retry" };
type TakesResponse = { shotId: string; regenerable: boolean; currentTakeId: string | null; takes: TakeView[] };

export function ClipTakes({
  jobId,
  clipId,
  currentSrc,
  busy,
  onChoose,
  onNewTake,
}: {
  jobId: string;
  clipId: string;
  /** The clip's current source: a change (another take chosen, undo) reloads the list. */
  currentSrc: string;
  busy: boolean;
  onChoose: (takeId: string) => void;
  onNewTake: () => void;
}) {
  const [data, setData] = useState<TakesResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/jobs/${jobId}/clip-takes?clipId=${encodeURIComponent(clipId)}`)
      .then((res) => (res.ok ? (res.json() as Promise<TakesResponse>) : Promise.reject(new Error(String(res.status)))))
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, clipId, currentSrc, busy]);

  if (failed) return null;
  if (!data) return <p className="text-xs text-[color:var(--ed-ink-faint)]">Loading takes…</p>;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-[color:var(--ed-ink-dim)]">
        Takes <span className="text-[color:var(--ed-ink-faint)]">({data.takes.length})</span>
      </p>
      <div className="grid grid-cols-3 gap-2">
        {data.takes.map((t, i) => {
          const current = t.id === data.currentTakeId;
          return (
            <button
              key={t.id}
              type="button"
              disabled={current}
              onClick={() => onChoose(t.id)}
              title={current ? "On the timeline" : `Use take ${i + 1}`}
              className={`group relative aspect-[9/16] overflow-hidden rounded-lg border bg-black ${
                current
                  ? "border-[color:var(--ed-accent)] shadow-[0_0_0_2px_var(--ed-accent-dim)]"
                  : "border-[color:var(--ed-border)] hover:border-[color:var(--ed-border-strong)]"
              }`}
            >
              <img
                src={`/api/jobs/${jobId}/preview-thumbnail?src=${encodeURIComponent(t.src)}&t=${(t.inSec + 0.3).toFixed(2)}`}
                alt={`Take ${i + 1}`}
                className="absolute inset-0 h-full w-full object-cover"
              />
              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 pt-4 pb-1 text-left text-[10px] leading-tight text-white">
                Take {i + 1}
                {current && <span className="block font-semibold text-[color:var(--ed-accent)]">In use</span>}
              </span>
            </button>
          );
        })}
        {data.regenerable && (
          <button
            type="button"
            disabled={busy}
            onClick={onNewTake}
            title="Generate another take of this shot"
            className="flex aspect-[9/16] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-[color:var(--ed-border-strong)] text-[10px] text-[color:var(--ed-ink-dim)] transition-colors hover:bg-[color:var(--ed-raised)] hover:text-[color:var(--ed-ink)] disabled:opacity-60"
          >
            {busy ? <RegenerateIcon className="h-4 w-4 animate-spin" /> : <PlusIcon className="h-4 w-4" />}
            {busy ? "Generating…" : "New take"}
          </button>
        )}
      </div>
      {!data.regenerable && (
        <p className="text-[11px] text-[color:var(--ed-ink-faint)]">This shot is the product&apos;s own screen recording, so there is nothing to regenerate.</p>
      )}
    </div>
  );
}

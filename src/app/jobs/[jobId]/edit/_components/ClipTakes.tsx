"use client";

import { useEffect, useRef, useState } from "react";
import { useAiVideoSource } from "./AiVideoSource";
import { PlusIcon, RegenerateIcon } from "./Icons";

/**
 * An AI video clip's takes, in the Inspector: every version of the shot ever
 * generated, the one on the timeline marked "In use". Clicking another take
 * puts it on the timeline (free, instant, undoable); "New take" generates
 * one more (see Editor's regenerateClip). Takes come from
 * /api/jobs/[jobId]/clip-takes; the list reloads whenever the clip's source
 * changes or a generation finishes.
 */

type TakeView = { id: string; src: string; inSec: number; createdAt: string; origin: "original" | "regenerated" | "retry"; label?: string; request?: string };
type TakesResponse = { shotId: string; regenerable: boolean; currentTakeId: string | null; takes: TakeView[] };

/**
 * The original shot beside the take that is on the timeline, both muted and
 * looping, so what the AI made can be judged against what it was asked to
 * recreate. The original is the viral video held to this shot's span.
 */
function SideBySide({ sourceUrl, span, takeSrc, takeInSec }: { sourceUrl: string; span: { startSec: number; endSec: number }; takeSrc: string; takeInSec: number }) {
  const original = useLoop(span.startSec, span.endSec);
  const generated = useLoop(takeInSec, takeInSec + Math.max(0.5, span.endSec - span.startSec));
  const tile = "aspect-[9/16] w-full rounded-lg border border-[color:var(--ed-border)] bg-black object-cover";
  return (
    <div data-testid="side-by-side" className="grid grid-cols-2 gap-2">
      <figure className="flex flex-col gap-1">
        <video ref={original} src={sourceUrl} muted playsInline autoPlay preload="metadata" aria-label="The original shot" className={tile} />
        <figcaption className="text-[11px] text-[color:var(--ed-ink-dim)]">Original</figcaption>
      </figure>
      <figure className="flex flex-col gap-1">
        <video ref={generated} src={takeSrc} muted playsInline autoPlay preload="metadata" aria-label="The take in use" className={tile} />
        <figcaption className="text-[11px] text-[color:var(--ed-ink-dim)]">In use</figcaption>
      </figure>
    </div>
  );
}

/** Plays a video between two times, over and over. */
function useLoop(startSec: number, endSec: number) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const begin = () => {
      v.currentTime = startSec;
    };
    const tick = () => {
      if (v.currentTime >= endSec || v.currentTime < startSec - 0.1) v.currentTime = startSec;
    };
    v.addEventListener("loadedmetadata", begin);
    v.addEventListener("timeupdate", tick);
    if (v.readyState >= 1) begin();
    return () => {
      v.removeEventListener("loadedmetadata", begin);
      v.removeEventListener("timeupdate", tick);
    };
  }, [startSec, endSec]);
  return ref;
}

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
  const source = useAiVideoSource();

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

  const span = source?.shots[data.shotId];
  const inUse = data.takes.find((t) => t.id === data.currentTakeId);

  return (
    <div className="flex flex-col gap-2">
      {source && span && inUse && <SideBySide sourceUrl={source.videoUrl} span={span} takeSrc={`/${inUse.src}`} takeInSec={inUse.inSec} />}
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
              title={`${current ? "On the timeline" : `Use take ${i + 1}`}${t.request ? `\nAsked for: ${t.request}` : ""}`}
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
                {t.label && <span className="block truncate text-white/70">{t.label}</span>}
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

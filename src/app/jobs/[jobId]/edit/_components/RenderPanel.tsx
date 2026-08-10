"use client";

import { useEffect, useRef, useState } from "react";

type FailedGate = { name: string; measured: string };

type RenderStatus =
  | { status: "idle" }
  | { status: "rendering"; startedAt: string; percent: number }
  | { status: "done"; startedAt: string; finishedAt: string; outUrl: string; failedGates?: FailedGate[] }
  | { status: "error"; startedAt: string; finishedAt: string; error: string };

const POLL_MS = 2500;

export function RenderPanel({ jobId }: { jobId: string }) {
  const [status, setStatus] = useState<RenderStatus>({ status: "idle" });
  const [discarding, setDiscarding] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = async () => {
    const res = await fetch(`/api/jobs/${jobId}/render`);
    const data: RenderStatus = await res.json();
    setStatus(data);
    if (data.status !== "rendering" && timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => {
    poll();
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const startRender = async () => {
    const res = await fetch(`/api/jobs/${jobId}/render`, { method: "POST" });
    const data: RenderStatus = await res.json();
    setStatus(data);
    if (data.status === "rendering" && !timer.current) {
      timer.current = setInterval(poll, POLL_MS);
    }
  };

  const discard = async () => {
    setDiscarding(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/render`, { method: "DELETE" });
      const data: RenderStatus = await res.json();
      setStatus(data);
    } finally {
      setDiscarding(false);
    }
  };

  return (
    // Height-bounded and scrollable: this panel is an absolutely-positioned
    // dropdown (see Editor.tsx's Export button), so it's out of flow and the
    // page can't scroll to reveal it. Once a render finishes, the failed-gate
    // list plus the result <video> easily exceed the viewport, which put the
    // download link past the bottom edge with no way to reach it.
    // overscroll-contain stops a scroll here from chaining to the editor
    // behind it once the panel hits its end.
    <div className="max-h-[calc(100vh-6rem)] overflow-y-auto overscroll-contain rounded-xl border border-[color:var(--ed-border-strong)] bg-[color:var(--ed-panel)] p-5 shadow-[0_12px_32px_rgba(0,0,0,0.45)]">
      <div className="flex items-center justify-between gap-3">
        <p className="font-[family-name:var(--ed-font-display)] font-semibold text-[color:var(--ed-ink)]">Render</p>
        <button
          onClick={startRender}
          disabled={status.status === "rendering"}
          className="rounded-lg bg-[color:var(--ed-accent)] px-4 py-2 text-sm font-semibold text-[color:var(--ed-accent-ink)] transition-transform hover:scale-[1.02] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
        >
          {status.status === "rendering" ? `Rendering… ${Math.round(status.percent)}%` : "Render final video"}
        </button>
      </div>
      {status.status === "rendering" && (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--ed-border)]">
          <div
            className="h-full rounded-full bg-[color:var(--ed-accent)] transition-[width] duration-300 ease-out"
            style={{ width: `${Math.min(100, Math.max(0, status.percent))}%` }}
          />
        </div>
      )}
      {status.status === "error" && (
        <p className="mt-3 text-sm text-[color:var(--ed-danger)]">{status.error}</p>
      )}
      {status.status === "done" && (
        <div className="mt-4">
          {status.failedGates && status.failedGates.length > 0 && (
            <div className="mb-3 rounded-lg border border-[color:var(--ed-danger)]/40 bg-[color:var(--ed-danger)]/10 p-3">
              <p className="text-sm font-semibold text-[color:var(--ed-danger)]">
                {status.failedGates.length} quality check{status.failedGates.length > 1 ? "s" : ""} flagged this render
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-[color:var(--ed-danger)]/90">
                {status.failedGates.map((g) => (
                  <li key={g.name}>
                    {g.name} — {g.measured}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-[color:var(--ed-ink)]/70">
                The video still plays fine — take a look and decide whether it's good enough to keep.
              </p>
            </div>
          )}
          <video src={status.outUrl} controls className="w-full rounded-lg" />
          <div className="mt-3 flex items-center gap-4">
            <a
              href={status.outUrl}
              download
              className="text-sm text-[color:var(--ed-accent)] hover:underline"
            >
              Download MP4
            </a>
            {status.failedGates && status.failedGates.length > 0 && (
              <button
                onClick={discard}
                disabled={discarding}
                className="text-sm text-[color:var(--ed-danger)] hover:underline disabled:opacity-40"
              >
                {discarding ? "Discarding…" : "Discard render"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

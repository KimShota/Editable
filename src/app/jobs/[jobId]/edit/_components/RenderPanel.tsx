"use client";

import { useEffect, useRef, useState } from "react";

type RenderStatus =
  | { status: "idle" }
  | { status: "rendering"; startedAt: string; percent: number }
  | { status: "done"; startedAt: string; finishedAt: string; outUrl: string }
  | { status: "error"; startedAt: string; finishedAt: string; error: string };

const POLL_MS = 2500;

export function RenderPanel({ jobId }: { jobId: string }) {
  const [status, setStatus] = useState<RenderStatus>({ status: "idle" });
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

  return (
    <div className="rounded-xl border border-[color:var(--ed-border-strong)] bg-[color:var(--ed-panel)] p-5 shadow-[0_12px_32px_rgba(0,0,0,0.45)]">
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
          <video src={status.outUrl} controls className="w-full rounded-lg" />
          <a
            href={status.outUrl}
            download
            className="mt-3 inline-block text-sm text-[color:var(--ed-accent)] hover:underline"
          >
            Download MP4
          </a>
        </div>
      )}
    </div>
  );
}

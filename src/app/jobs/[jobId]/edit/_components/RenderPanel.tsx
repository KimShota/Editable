"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "../../../../_components/ui";

type RenderStatus =
  | { status: "idle" }
  | { status: "rendering"; startedAt: string }
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
    <div className="rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="font-[family-name:var(--font-display)] font-bold text-[color:var(--ink)]">Render</p>
        <Button onClick={startRender} disabled={status.status === "rendering"}>
          {status.status === "rendering" ? "Rendering…" : "Render final video"}
        </Button>
      </div>
      {status.status === "error" && <p className="mt-3 text-sm text-red-400">{status.error}</p>}
      {status.status === "done" && (
        <div className="mt-4">
          <video src={status.outUrl} controls className="w-full rounded-lg" />
          <a
            href={status.outUrl}
            download
            className="mt-3 inline-block text-sm text-[color:var(--accent)] hover:underline"
          >
            Download MP4
          </a>
        </div>
      )}
    </div>
  );
}

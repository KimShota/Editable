"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { finishedStages, type StageSpec, stageProgress } from "@backend/queue/stages";
import type { PublicTask } from "../api/tasks/taskView";
import { Button } from "./ui";

/**
 * Progress for one queue job, or for a scripted replay of one
 * (plan/ui-ux-full-flow.md §2.4). Every screen that starts slow work shows
 * this, so "Generating storyboard · shot 3 of 7" looks the same everywhere.
 *
 *   <TaskProgress taskId={id} title="Generating storyboard" />
 *   <TaskProgress replay={{ steps: […], durationMs: 6000 }} title="Reading your site" />
 *
 * Real mode polls GET /api/tasks/<id> until the task is done or failed. It
 * does not poll while the tab is hidden, and polls straight away when the tab
 * comes back. Replay mode plays `steps` evenly across `durationMs` and
 * finishes: the onboarding demo uses it to show a run that already happened
 * on disk without spending anything.
 *
 * The filled part is always the real progress. The shimmer moving over it
 * only says "still working", so a long step (one paid clip can take minutes)
 * never looks frozen. With `stages` the bar spans the whole job and a step
 * track shows where it is.
 *
 * When the task finishes, `onDone` is called once; without it the page is
 * refreshed (router.refresh()) so server components re-read what the job
 * wrote.
 */

export type ReplayStep = { stage: string; message?: string };

type Props = {
  taskId?: number;
  replay?: { steps: ReplayStep[]; durationMs: number };
  title?: string;
  onDone?: () => void;
  /** Shows a Retry button on failure. */
  onRetry?: () => void;
  /** One bar across a job's named stages (see backend/queue/stages.ts), with a step track under it.
   *  Ignored while the job reports a stage that is not listed. */
  stages?: StageSpec[];
  pollMs?: number;
  className?: string;
};

type View = {
  status: "waiting" | "running" | "done" | "failed" | "lost";
  stage: string | null;
  done: number | null;
  total: number | null;
  message: string | null;
  error: string | null;
};

const INITIAL: View = { status: "waiting", stage: null, done: null, total: null, message: null, error: null };

const fromTask = (task: PublicTask): View => ({
  status: task.status === "queued" ? "waiting" : task.status === "running" ? "running" : task.status === "done" ? "done" : "failed",
  stage: task.progress?.stage ?? null,
  done: task.progress?.done ?? null,
  total: task.progress?.total ?? null,
  message: task.progress?.message ?? null,
  error: task.error,
});

export function TaskProgress({ taskId, replay, title, onDone, onRetry, stages, pollMs = 1500, className = "" }: Props) {
  const router = useRouter();
  const [view, setView] = useState<View>(INITIAL);
  const [offline, setOffline] = useState(false);
  const finished = useRef(false);
  // Latest callbacks without restarting the effects that call them.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    if (onDoneRef.current) onDoneRef.current();
    else router.refresh();
  };

  // Real task: poll until it settles.
  useEffect(() => {
    if (taskId === undefined || replay) return;
    finished.current = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0;

    const poll = async () => {
      if (stopped) return;
      if (document.hidden) {
        timer = setTimeout(poll, pollMs);
        return;
      }
      try {
        const res = await fetch(`/api/tasks/${taskId}`, { cache: "no-store" });
        if (res.status === 404 || res.status === 401) {
          setView({ ...INITIAL, status: "lost", error: "We can no longer find this step." });
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const next = fromTask((await res.json()) as PublicTask);
        misses = 0;
        setOffline(false);
        setView(next);
        if (next.status === "done") return finish();
        if (next.status === "failed") return;
      } catch {
        // A blip must not look like a failure; only say so if it keeps up.
        if (++misses >= 3) setOffline(true);
      }
      timer = setTimeout(poll, pollMs);
    };

    const onVisible = () => {
      if (!document.hidden && !stopped) {
        clearTimeout(timer);
        void poll();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // finish() only touches refs and the router, which are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, pollMs, replay]);

  // Replay: walk the scripted steps across the duration.
  useEffect(() => {
    if (!replay) return;
    finished.current = false;
    const { steps, durationMs } = replay;
    const startedAt = Date.now();
    const tick = () => {
      const p = Math.min(1, (Date.now() - startedAt) / durationMs);
      const index = Math.min(steps.length - 1, Math.floor(p * steps.length));
      setView({
        status: p >= 1 ? "done" : "running",
        stage: steps[index]?.stage ?? null,
        done: Math.min(steps.length, Math.floor(p * steps.length)),
        total: steps.length,
        message: steps[index]?.message ?? null,
        error: null,
      });
      if (p >= 1) {
        clearInterval(interval);
        finish();
      }
    };
    const interval = setInterval(tick, 120);
    tick();
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay?.durationMs, replay?.steps.length]);

  const finishedOk = view.status === "done";
  const staged = stages ? (finishedOk ? finishedStages(stages) : stageProgress(stages, view.stage, view.done, view.total)) : null;
  const determinate = staged !== null || (view.total !== null && view.total > 0 && view.done !== null);
  const pct = finishedOk ? 100 : staged ? staged.percent : determinate ? Math.round((Math.min(view.done!, view.total!) / view.total!) * 100) : 0;
  const failed = view.status === "failed" || view.status === "lost";
  const heading = failed ? "Something went wrong" : finishedOk ? "Done" : (title ?? "Working");
  const detail = failed
    ? view.error
    : view.status === "waiting"
      ? "Waiting to start…"
      : [view.stage, view.total !== null && view.total > 0 && view.done !== null ? `${view.done} of ${view.total}` : null, view.message].filter(Boolean).join(" · ");

  return (
    <div
      role="status"
      aria-live="polite"
      data-task-status={view.status}
      className={`rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)] p-4 ${className}`}
    >
      <div className="flex items-baseline justify-between gap-4">
        <p className="font-[family-name:var(--font-display)] text-sm font-semibold text-[color:var(--ink)]">{heading}</p>
        {determinate && !failed && <p className="text-xs tabular-nums text-[color:var(--ink-dim)]" data-testid="task-percent">{pct}%</p>}
      </div>

      <div
        role="progressbar"
        aria-label={heading}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={failed ? undefined : determinate || finishedOk ? pct : undefined}
        className={`mt-3 w-full overflow-hidden rounded-full bg-[color:var(--bg-2)] ${stages ? "h-2" : "h-1.5"}`}
      >
        {failed ? (
          <div className="h-full w-full bg-[color:var(--st-bad-fg)]/30" />
        ) : determinate || finishedOk ? (
          <div className="task-bar__fill h-full rounded-full" data-state={finishedOk ? "done" : "working"} style={{ width: `${pct}%` }} />
        ) : (
          <div className="task-bar__indeterminate h-full rounded-full bg-[color:var(--accent)]" />
        )}
      </div>

      {staged && !failed && (
        <ol aria-label="Steps" className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
          {staged.steps.map((step) => (
            <li key={step.label} data-step={step.state} aria-current={step.state === "current" ? "step" : undefined} className="flex items-center gap-1.5 text-xs">
              <span aria-hidden="true" className="task-step__dot" data-state={step.state} />
              <span className={step.state === "current" ? "font-medium text-[color:var(--ink)]" : "text-[color:var(--ink-dim)]"}>{step.label}</span>
              <span className="sr-only">{step.state === "done" ? ", done" : step.state === "current" ? ", in progress" : ", waiting"}</span>
            </li>
          ))}
        </ol>
      )}

      {detail && <p className={`mt-2 text-[13px] ${failed ? "text-[color:var(--st-bad-fg)]" : "text-[color:var(--ink-dim)]"}`}>{detail}</p>}
      {offline && !failed && view.status !== "done" && <p className="mt-1 text-xs text-[color:var(--ink-dim)]">Connection lost. Still trying…</p>}
      {failed && onRetry && (
        <div className="mt-3">
          <Button variant="secondary" onClick={onRetry} className="!px-4 !py-2 !text-[13px]">
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

"use client";

import { type ReactNode, useEffect, useState } from "react";
import { type ReplayStep, TaskProgress } from "../../../_components/TaskProgress";

/**
 * Plays a short, scripted "this is being made" progress, then shows what was
 * made. The onboarding replay uses it to show a setup that already happened
 * (its files are on disk) with the pacing of a live one, without spending
 * anything. A presenter can skip ahead, and coming back to a step the same
 * session shows it straight away instead of replaying it.
 */
export function ReplayGate({ id, title, steps, durationMs, children }: { id: string; title: string; steps: ReplayStep[]; durationMs: number; children: ReactNode }) {
  const key = `katalab.replay.${id}`;
  // Not read during render: server and client must agree on the first paint.
  const [done, setDone] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(key) === "1") setDone(true);
    } catch {
      // Storage blocked: the replay simply plays each time.
    }
    setChecked(true);
  }, [key]);

  const finish = () => {
    setDone(true);
    try {
      window.sessionStorage.setItem(key, "1");
    } catch {
      // Not remembered, which only means it can replay.
    }
  };

  if (done) return <div className="replay-reveal">{children}</div>;
  if (!checked) return <div aria-hidden="true" className="h-40" />;

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 py-10">
      <TaskProgress replay={{ steps, durationMs }} title={title} onDone={finish} />
      <div>
        <button type="button" onClick={finish} className="text-sm font-medium text-[color:var(--ink-dim)] underline-offset-4 hover:text-[color:var(--ink)] hover:underline focus-visible:outline-2 focus-visible:outline-[color:var(--accent)]">
          Skip
        </button>
      </div>
    </div>
  );
}
